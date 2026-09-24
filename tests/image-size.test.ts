import { describe, expect, it } from "vitest";
import { imageSize } from "@/lib/image-size";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, a dummy APP0 segment, then SOF0 carrying dimensions.
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOF0, len 17, precision 8
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([head, sof]);
}

describe("imageSize", () => {
  it("reads PNG dimensions (landscape)", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  it("reads PNG dimensions (portrait)", () => {
    expect(imageSize(png(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });
  it("reads GIF dimensions", () => {
    expect(imageSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("reads JPEG dimensions from SOF0", () => {
    expect(imageSize(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
  });
  it("returns null for unknown/short buffers", () => {
    expect(imageSize(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(imageSize(Buffer.alloc(40))).toBeNull();
  });
});
