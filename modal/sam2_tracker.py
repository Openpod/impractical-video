from fastapi import Request
import base64
import os
import tempfile
from pathlib import Path
from typing import Any

import modal


MODEL_ID = os.environ.get("SAM2_MODEL_ID", "facebook/sam2-hiera-small")
MAX_SECONDS = float(os.environ.get("SAM2_MAX_SECONDS", "20"))
TARGET_FPS = float(os.environ.get("SAM2_TARGET_FPS", "15"))
MAX_WIDTH = int(os.environ.get("SAM2_MAX_WIDTH", "720"))

image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime",
    )
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install(
        "fastapi[standard]",
        "huggingface_hub",
        "numpy",
        "opencv-python-headless",
        "pydantic",
        "requests",
        "git+https://github.com/facebookresearch/sam2.git",
    )
)

app = modal.App("video-fs-sam2-tracker", image=image)

_predictor = None


def _auth_token() -> str | None:
    return os.environ.get("SAM2_TRACKER_TOKEN")


def _load_predictor():
    global _predictor
    if _predictor is not None:
        return _predictor

    from sam2.sam2_video_predictor import SAM2VideoPredictor

    _predictor = SAM2VideoPredictor.from_pretrained(MODEL_ID)
    return _predictor


def _download_video(url: str, output_path: Path) -> None:
    import requests

    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with output_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def _write_image_frame(image_base64: str, frames_dir: Path) -> tuple[list[float], int, int]:
    import cv2
    import numpy as np

    raw = base64.b64decode(image_base64.split(",", 1)[-1])
    data = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode image_base64.")

    height, width = frame.shape[:2]
    if width > MAX_WIDTH:
        scale = MAX_WIDTH / width
        frame = cv2.resize(frame, (MAX_WIDTH, max(1, int(round(height * scale)))))
        height, width = frame.shape[:2]
    cv2.imwrite(str(frames_dir / "000000.jpg"), frame)
    return [0.0], width, height


def _extract_frames(video_path: Path, frames_dir: Path, start_time: float) -> tuple[list[float], int, int]:
    import cv2

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("Could not open video.")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    start_frame = max(0, int(round(start_time * source_fps)))
    end_frame = start_frame + int(round(MAX_SECONDS * source_fps))
    frame_stride = max(1, int(round(source_fps / TARGET_FPS)))
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    timestamps: list[float] = []
    frame_index = start_frame
    saved_index = 0
    saved_width = 0
    saved_height = 0

    while frame_index <= end_frame:
        ok, frame = capture.read()
        if not ok or frame is None:
            break

        if (frame_index - start_frame) % frame_stride == 0:
            height, width = frame.shape[:2]
            if width > MAX_WIDTH:
                scale = MAX_WIDTH / width
                frame = cv2.resize(frame, (MAX_WIDTH, max(1, int(round(height * scale)))))
                height, width = frame.shape[:2]
            saved_width = width
            saved_height = height
            cv2.imwrite(str(frames_dir / f"{saved_index:06d}.jpg"), frame)
            timestamps.append(frame_index / source_fps)
            saved_index += 1

        frame_index += 1

    capture.release()
    if not timestamps:
        raise ValueError("No frames extracted for tracking.")
    return timestamps, saved_width, saved_height


def _mask_array(mask: Any):
    import numpy as np

    mask_array = mask.detach().float().cpu().numpy() if hasattr(mask, "detach") else np.asarray(mask)
    if mask_array.ndim == 3:
        mask_array = mask_array[0]
    return mask_array > 0


def _mask_to_box(mask: Any, width: int, height: int) -> dict[str, float] | None:
    import numpy as np

    mask_array = _mask_array(mask)
    ys, xs = np.where(mask_array)
    if xs.size == 0 or ys.size == 0:
        return None

    x1 = float(xs.min())
    x2 = float(xs.max() + 1)
    y1 = float(ys.min())
    y2 = float(ys.max() + 1)
    return {
        "x": max(0.0, min(1.0, x1 / width)),
        "y": max(0.0, min(1.0, y1 / height)),
        "w": max(0.0, min(1.0, (x2 - x1) / width)),
        "h": max(0.0, min(1.0, (y2 - y1) / height)),
    }


def _mask_to_png_base64(mask: Any) -> str:
    import cv2
    import numpy as np

    mask_array = (_mask_array(mask).astype(np.uint8) * 255)
    ok, encoded = cv2.imencode(".png", mask_array)
    if not ok:
        raise ValueError("Could not encode mask PNG.")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def _mask_to_contour(mask: Any, width: int, height: int) -> list[list[float]]:
    import cv2
    import numpy as np

    mask_array = (_mask_array(mask).astype(np.uint8) * 255)
    contours, _hierarchy = cv2.findContours(mask_array, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    epsilon = max(1.0, 0.0025 * cv2.arcLength(contour, True))
    approx = cv2.approxPolyDP(contour, epsilon, True)
    return [[float(p[0][0]) / width, float(p[0][1]) / height] for p in approx]


@app.function(
    gpu=os.environ.get("MODAL_GPU", "L4"),
    timeout=600,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("video-fs-sam2-tracker")],
)
@modal.fastapi_endpoint(method="POST")
def track(payload: dict, request: Request):
    from fastapi import HTTPException
    import numpy as np
    import torch

    expected_token = _auth_token()
    auth_header = request.headers.get("authorization", "")
    if expected_token and auth_header != f"Bearer {expected_token}":
        raise HTTPException(status_code=401, detail="Unauthorized")

    video_url = payload.get("video_url")
    image_base64 = payload.get("image_base64")
    user_box = payload.get("box") or {}
    user_points = payload.get("points") or []
    start_time = float(payload.get("start_time") or 0)
    return_masks = bool(payload.get("return_masks"))
    if not isinstance(video_url, str) and not isinstance(image_base64, str):
        raise HTTPException(status_code=400, detail="video_url or image_base64 is required")

    with tempfile.TemporaryDirectory() as temp_root:
        temp_path = Path(temp_root)
        video_path = temp_path / "input.mp4"
        frames_dir = temp_path / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)

        if isinstance(image_base64, str):
            timestamps, width, height = _write_image_frame(image_base64, frames_dir)
        else:
            _download_video(video_url, video_path)
            timestamps, width, height = _extract_frames(video_path, frames_dir, start_time)

        box = None
        if user_box:
            x1 = float(user_box.get("x", 0)) * width
            y1 = float(user_box.get("y", 0)) * height
            x2 = x1 + float(user_box.get("w", 0)) * width
            y2 = y1 + float(user_box.get("h", 0)) * height
            box = np.array([x1, y1, x2, y2], dtype=np.float32)
        points = None
        labels = None
        if isinstance(user_points, list) and user_points:
            points = np.array(
                [[float(p.get("x", 0)) * width, float(p.get("y", 0)) * height] for p in user_points],
                dtype=np.float32,
            )
            labels = np.array([int(p.get("label", 1)) for p in user_points], dtype=np.int32)

        predictor = _load_predictor()
        boxes = []
        returned_masks = []
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            state = predictor.init_state(video_path=str(frames_dir))
            predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=0,
                obj_id=1,
                points=points,
                labels=labels,
                box=box,
            )
            for frame_idx, _object_ids, masks in predictor.propagate_in_video(state):
                if frame_idx >= len(timestamps):
                    continue
                first_mask = masks[0] if len(masks) else None
                mask_box = _mask_to_box(first_mask, width, height) if first_mask is not None else None
                if not mask_box:
                    continue
                if return_masks:
                    returned_masks.append(
                        {
                            "frame": int(frame_idx),
                            "t": timestamps[frame_idx],
                            "png_base64": _mask_to_png_base64(first_mask),
                            "contour": _mask_to_contour(first_mask, width, height),
                        }
                    )
                boxes.append(
                    {
                        "frame": int(frame_idx),
                        "t": timestamps[frame_idx],
                        "confidence": 0.95,
                        **mask_box,
                    }
                )

        return {
            "boxes": boxes,
            "frames_processed": len(timestamps),
            "height": height,
            "masks": returned_masks if return_masks else [],
            "model": MODEL_ID,
            "tracker": "sam2",
            "width": width,
        }
