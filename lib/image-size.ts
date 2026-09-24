/**
 * Dependency-free intrinsic dimensions for the common raster formats we store
 * (PNG, JPEG, GIF, WebP). Returns null when the format/header is unrecognized,
 * so callers store null rather than guessing. Used at publish time so the
 * Explore masonry can classify orientation before paint (no layout shift).
 */
export type ImageSize = { width: number; height: number };

export function imageSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width@16, height@20 (BE).
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: "GIF", width@6, height@8 (LE).
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // WebP: "RIFF"...."WEBP" + a VP8 variant chunk.
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const fourcc = buffer.toString("ascii", 12, 16);
    if (fourcc === "VP8X" && buffer.length >= 30) {
      return {
        width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    if (fourcc === "VP8 " && buffer.length >= 30) {
      // Lossy keyframe: 14-bit dimensions at 26/28 (LE).
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    return null; // VP8L (lossless) bit-packing not handled; rare for our media.
  }

  // JPEG: FFD8, then walk markers to the first Start-Of-Frame.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0..SOF15 except DHT(C4)/DAC(CC)/RSTn — these carry frame dimensions.
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // standalone markers, no length
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
  }

  return null;
}
