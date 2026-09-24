import { compareHashes, diff, Jimp } from "jimp";

export type ImageSimilarity = {
  hashDistance: number;
  pixelDiff: number;
};

export const NEAR_DUPLICATE_HASH_DISTANCE = 0.06;
export const HIGH_SIMILARITY_HASH_DISTANCE = 0.16;
export const NEAR_DUPLICATE_PIXEL_DIFF = 0.015;

function bufferFromDataUrl(value: string): Buffer | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  return match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]));
}

async function bytesFromSource(source: string | Uint8Array): Promise<Buffer> {
  if (typeof source !== "string") return Buffer.from(source);
  const dataUrl = bufferFromDataUrl(source);
  if (dataUrl) return dataUrl;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Could not fetch image (${response.status}) from ${source}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return Buffer.from(source);
}

export async function imagePerceptualHash(
  source: string | Uint8Array,
): Promise<string> {
  const image = await Jimp.read(await bytesFromSource(source));
  return image.hash();
}

export function imageHashDistance(hashA: string, hashB: string): number {
  return compareHashes(hashA, hashB);
}

export function isNearDuplicateDistance(distance: number): boolean {
  return distance <= NEAR_DUPLICATE_HASH_DISTANCE;
}

export function isHighSimilarityDistance(distance: number): boolean {
  return distance <= HIGH_SIMILARITY_HASH_DISTANCE;
}

export async function compareImages(
  sourceA: string | Uint8Array,
  sourceB: string | Uint8Array,
): Promise<ImageSimilarity> {
  const [imageA, imageB] = await Promise.all([
    Jimp.read(await bytesFromSource(sourceA)),
    Jimp.read(await bytesFromSource(sourceB)),
  ]);
  const hashDistance = imageHashDistance(imageA.hash(), imageB.hash());
  const normalizedA = imageA.clone().resize({ w: 96, h: 54 });
  const normalizedB = imageB.clone().resize({ w: 96, h: 54 });
  const pixelDiff = diff(normalizedA, normalizedB).percent;
  return { hashDistance, pixelDiff };
}

export function isNearDuplicateSimilarity(similarity: ImageSimilarity): boolean {
  return (
    similarity.hashDistance <= NEAR_DUPLICATE_HASH_DISTANCE ||
    similarity.pixelDiff <= NEAR_DUPLICATE_PIXEL_DIFF
  );
}
