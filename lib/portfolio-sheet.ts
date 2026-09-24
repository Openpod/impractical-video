import { deflateSync } from "node:zlib";
import { uploadToFalStorage } from "@/lib/media";
import { hostProjectBytes } from "@/lib/workspace";
import type { ReferenceCategory } from "@/lib/source-graph";

export const DEFAULT_PORTFOLIO_FORMAT = "3x3_contact_sheet";
export const PORTFOLIO_SCAFFOLD_SIZE = 902;
export const PORTFOLIO_SCAFFOLD_MARGIN = 2;
export const PORTFOLIO_SCAFFOLD_GUTTER = 2;
export const PORTFOLIO_SCAFFOLD_CELL =
  (PORTFOLIO_SCAFFOLD_SIZE - PORTFOLIO_SCAFFOLD_MARGIN * 2 - PORTFOLIO_SCAFFOLD_GUTTER * 2) / 3;

let portfolioScaffoldUrl: string | null = null;

export const PORTFOLIO_TEXT_RESTRICTION =
  "No non-diegetic text: do not render labels, captions, title cards, numbered cells, shot-size names, camera-angle notes, annotations, UI overlays, subtitles, watermarks, logos, or any floating/explanatory text. Shot-size terms like ELS, LS, MS, MCU, CU, and ECU are internal composition instructions only and must never appear as visible text. Diegetic text physically present in the world is allowed only when the reference explicitly requires it; otherwise avoid it or keep it abstract and illegible.";

export const PORTFOLIO_GRID_TEMPLATE = [
  "Use this strict 3x3 empty portfolio template and fill every square:",
  "",
  "[ 1 ][ 2 ][ 3 ]",
  "[ 4 ][ 5 ][ 6 ]",
  "[ 7 ][ 8 ][ 9 ]",
  "",
  "Preserve the grid: nine equal rectangular cells, even gutters, clean contact-sheet layout.",
  "Each cell must be a different useful production view of the SAME subject/place/style.",
  "Do not merge cells, do not make a collage, and do not add visible cell numbers, borders, or graphic design elements.",
  PORTFOLIO_TEXT_RESTRICTION,
  "Treat every row/column instruction below as invisible art direction, never as typography inside the image.",
  "Fill each cell edge-to-edge with cinematic imagery while keeping the subject identity consistent across all nine cells.",
].join("\n");

export const PORTFOLIO_SCAFFOLD_INSTRUCTION =
  "A blank 3x3 scaffold image is provided as the first visual reference. Follow that exact nine-cell structure and even gutter spacing, but replace every blank cell with cinematic imagery; do not add visible numbers, labels, captions, or UI.";

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

export function createPortfolioScaffoldPng() {
  const width = PORTFOLIO_SCAFFOLD_SIZE;
  const height = PORTFOLIO_SCAFFOLD_SIZE;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel + 1;
  const raw = Buffer.alloc(stride * height);
  const background = [237, 29, 36, 255] as const;
  const cell = [255, 255, 255, 255] as const;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      let inCell = false;
      for (let row = 0; row < 3 && !inCell; row += 1) {
        const top = PORTFOLIO_SCAFFOLD_MARGIN + row * (PORTFOLIO_SCAFFOLD_CELL + PORTFOLIO_SCAFFOLD_GUTTER);
        for (let col = 0; col < 3; col += 1) {
          const left =
            PORTFOLIO_SCAFFOLD_MARGIN + col * (PORTFOLIO_SCAFFOLD_CELL + PORTFOLIO_SCAFFOLD_GUTTER);
          if (
            x >= left &&
            x < left + PORTFOLIO_SCAFFOLD_CELL &&
            y >= top &&
            y < top + PORTFOLIO_SCAFFOLD_CELL
          ) {
            inCell = true;
            break;
          }
        }
      }
      const color = inCell ? cell : background;
      const pixelStart = rowStart + 1 + x * bytesPerPixel;
      raw[pixelStart] = color[0];
      raw[pixelStart + 1] = color[1];
      raw[pixelStart + 2] = color[2];
      raw[pixelStart + 3] = color[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed scaffold URLs expire (6h TTL); cache per project just under that. */
const scaffoldUrlByProject = new Map<string, { expiresAt: number; url: string }>();

export async function getPortfolioScaffoldUrl(projectId?: string) {
  if (projectId) {
    const cached = scaffoldUrlByProject.get(projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const hosted = await hostProjectBytes(
      projectId,
      "portfolio-3x3-scaffold.png",
      createPortfolioScaffoldPng(),
    );
    if (!hosted.ok) return null;
    scaffoldUrlByProject.set(projectId, {
      expiresAt: Date.now() + 5 * 60 * 60 * 1000,
      url: hosted.url,
    });
    return hosted.url;
  }
  // No project workspace = offline curated-library scripts only; app runtime
  // always passes projectId so user-facing media stays on our storage.
  if (portfolioScaffoldUrl) return portfolioScaffoldUrl;
  const upload = await uploadToFalStorage(
    createPortfolioScaffoldPng(),
    "portfolio-3x3-scaffold.png",
    "image/png",
  );
  if (!upload.ok) return null;
  portfolioScaffoldUrl = upload.url;
  return upload.url;
}

export function portfolioPromptContract(category: ReferenceCategory) {
  if (category === "styles") {
    return [
      "Create a clean reusable style portfolio contact sheet.",
      PORTFOLIO_GRID_TEMPLATE,
      "Keep one coherent visual language across the sheet.",
    ].join("\n");
  }
  if (category === "environments") {
    return [
      "Create a clean 3x3 cinematic portfolio contact sheet for this recurring environment.",
      PORTFOLIO_GRID_TEMPLATE,
      "Keep one coherent place across all nine cells.",
      "Row 1: ELS/LS geography and establishing views.",
      "Row 2: MLS/MS usable action spaces, paths, entrances, cover, and staging zones.",
      "Row 3: MCU/CU/ECU texture and detail views: materials, hazards, props, atmosphere.",
      "Columns: different camera directions within the same place, not unrelated locations.",
    ].join("\n");
  }
  const subject = category === "characters" ? "character" : "object, prop, robot, creature, or vehicle";
  const identityViews =
    category === "characters"
      ? "Row 1: FULL-BODY standing views, head-to-toe, the figure filling ~85% of each cell's height — the identity must be clearly readable, not a distant silhouette."
      : "Row 1: FULL-SUBJECT views with the entire object visible and filling ~85% of each cell — the design must be clearly readable, not a distant silhouette.";
  return [
    `Create a clean 3x3 cinematic portfolio contact sheet for this recurring ${subject}.`,
    PORTFOLIO_GRID_TEMPLATE,
    "Keep one consistent identity/design across all nine cells.",
    identityViews,
    "Row 2: MLS/MS readable action/body-language or functional views.",
    "Row 3: MCU/CU/ECU detail views (face, hands, materials, signature details).",
    "Columns: front, 3/4, side or action variation.",
  ].join("\n");
}
