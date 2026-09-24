#!/usr/bin/env python3
import argparse
import json
import sys


def create_tracker(cv2):
    if hasattr(cv2, "TrackerKCF_create"):
        return "kcf", cv2.TrackerKCF_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerKCF_create"):
        return "kcf", cv2.legacy.TrackerKCF_create()
    if hasattr(cv2, "TrackerCSRT_create"):
        return "csrt", cv2.TrackerCSRT_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerCSRT_create"):
        return "csrt", cv2.legacy.TrackerCSRT_create()
    if hasattr(cv2, "TrackerMIL_create"):
        return "opencv", cv2.TrackerMIL_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerMIL_create"):
        return "opencv", cv2.legacy.TrackerMIL_create()
    raise RuntimeError("OpenCV was installed without KCF/CSRT/MIL tracker support.")


def clamp(value, low, high):
    return max(low, min(high, value))


def preview_frame(cv2, frame, max_width=720):
    height, width = frame.shape[:2]
    if width <= max_width:
        return frame
    scale = max_width / width
    return cv2.resize(frame, (max_width, max(1, int(round(height * scale)))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--start-time", type=float, required=True)
    parser.add_argument("--x", type=float, required=True)
    parser.add_argument("--y", type=float, required=True)
    parser.add_argument("--w", type=float, required=True)
    parser.add_argument("--h", type=float, required=True)
    args = parser.parse_args()

    try:
        import cv2
    except Exception as exc:
        raise RuntimeError(
            "Python OpenCV is not installed. Install python3-opencv in the Trigger runtime."
        ) from exc

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError("Could not open video input.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    start_frame = max(0, int(round(args.start_time * fps)))
    if frame_count > 0:
        start_frame = min(start_frame, frame_count - 1)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    ok, frame = cap.read()
    if not ok or frame is None:
        raise RuntimeError("Could not read start frame.")

    frame = preview_frame(cv2, frame)
    height, width = frame.shape[:2]
    x = clamp(args.x * width, 0, width - 1)
    y = clamp(args.y * height, 0, height - 1)
    w = clamp(args.w * width, 2, width - x)
    h = clamp(args.h * height, 2, height - y)

    tracker_name, tracker = create_tracker(cv2)
    initialized = tracker.init(frame, (int(round(x)), int(round(y)), int(round(w)), int(round(h))))
    if initialized is False:
        raise RuntimeError("Could not initialize tracker.")

    boxes = [
        {
            "frame": start_frame,
            "t": start_frame / fps,
            "x": x / width,
            "y": y / height,
            "w": w / width,
            "h": h / height,
            "confidence": 1,
        }
    ]

    frame_index = start_frame + 1
    max_frames = min(frame_count, start_frame + int(fps * 30)) if frame_count > 0 else start_frame + int(fps * 30)
    while frame_index < max_frames:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        frame = preview_frame(cv2, frame)
        tracked, bbox = tracker.update(frame)
        if not tracked:
            break
        bx, by, bw, bh = bbox
        bx = clamp(float(bx), 0, width - 1)
        by = clamp(float(by), 0, height - 1)
        bw = clamp(float(bw), 1, width - bx)
        bh = clamp(float(bh), 1, height - by)
        boxes.append(
            {
                "frame": frame_index,
                "t": frame_index / fps,
                "x": bx / width,
                "y": by / height,
                "w": bw / width,
                "h": bh / height,
                "confidence": 0.9,
            }
        )
        frame_index += 1

    cap.release()
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump({"boxes": boxes, "tracker": tracker_name}, handle)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
