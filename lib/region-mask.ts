import { Jimp } from "jimp";
import { type RegionBox } from "@/lib/generation-contract";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Rasterize a normalized RegionBox into a PNG mask buffer for region-bounded
 * image editing (e.g. gpt-image-2/edit): the region is painted WHITE — the
 * editable area — and everything else BLACK — preserved pixel-for-pixel. This is
 * what turns a `scene_state` character region into a hard injection mask so the
 * model can only place/alter that one character inside its box.
 */
export async function rasterizeRegionMaskPng(
  region: RegionBox,
  width: number,
  height: number,
): Promise<Buffer> {
  const base = new Jimp({ width, height, color: 0x000000ff });
  const x = Math.round(clamp01(region.x) * width);
  const y = Math.round(clamp01(region.y) * height);
  const w = Math.round(clamp01(region.w) * width);
  const h = Math.round(clamp01(region.h) * height);
  if (w > 0 && h > 0) {
    const white = new Jimp({
      width: Math.min(w, width - x),
      height: Math.min(h, height - y),
      color: 0xffffffff,
    });
    base.composite(white, x, y);
  }
  return base.getBuffer("image/png");
}
