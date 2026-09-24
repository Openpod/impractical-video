#!/usr/bin/env tsx
import path from "node:path";
import {
  runVideoPortfolioPipeline,
  type VideoPortfolioSource,
} from "@/lib/video-portfolio-pipeline";
import {
  createLocalDirSink,
  createWorkspaceSink,
  type VideoPortfolioSink,
} from "@/lib/video-portfolio-sink";

function usage() {
  return `Usage:
  npm run extract:video-portfolio -- <input> <output> [options]

Input (exactly one):
  --video <local-path>                 A video file on disk.
  --workspace-video <media/path.mp4>   A video in a project workspace (requires --project).
  --video-url <https://...>            Any reachable video URL.
  --ai-video-entry <id>                An ai_video_entries row (Explore / rendered library).

Output (exactly one):
  --out-dir <dir>                      Write the reference tree to a local directory.
  --project <id>                       Write into a live project workspace (Supabase).

  For --video-url / --ai-video-entry, --out-dir is the default (a project is
  not a natural owner of a DB video). Pass --project explicitly to override.

Options:
  --skip-portfolio                     Extraction-only: Gemini + evidence frames,
                                       no paid Nano Banana sheets (review first).
  --ledger <path>                      Batch character-name ledger JSON (unique
                                       names across the batch).
  --analyzer <openrouter|gemini>       Analysis backend. Defaults to openrouter
                                       when OPENROUTER_API_KEY is set, else gemini.
  --model <model>                      Override the model id (provider-specific:
                                       e.g. google/gemini-3-flash-preview for
                                       openrouter, gemini-3-flash-preview for gemini).
  --max-entities <n>                   Cap extracted entities (default 24).
  --max-points <n>                     Cap timestamp points per entity (default 9, max 9).
  --keep-temp                          Keep the temp working directory.

Environment:
  OPENROUTER_API_KEY (default analyzer) or GEMINI_API_KEY (--analyzer gemini).
  For --workspace-video / --ai-video-entry / --project: NEXT_PUBLIC_SUPABASE_URL
  and SUPABASE_SERVICE_ROLE_KEY are required.
  FFMPEG_PATH may be set if ffmpeg is not on PATH.`;
}

function readArgs(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  console.error(usage());
  process.exit(1);
}

function resolveSource(args: Record<string, string | true>): VideoPortfolioSource {
  const video = str(args.video);
  const workspaceVideo = str(args["workspace-video"]);
  const videoUrl = str(args["video-url"]);
  const aiVideoEntry = str(args["ai-video-entry"]);
  const provided = [
    video && "--video",
    workspaceVideo && "--workspace-video",
    videoUrl && "--video-url",
    aiVideoEntry && "--ai-video-entry",
  ].filter(Boolean);
  if (provided.length === 0) fail("Provide an input source.");
  if (provided.length > 1) fail(`Input sources are mutually exclusive (got ${provided.join(", ")}).`);

  if (video) return { kind: "local", path: path.resolve(video) };
  if (workspaceVideo) {
    const projectId = str(args.project);
    if (!projectId) fail("--workspace-video requires --project <id>.");
    return { kind: "workspace", projectId, path: workspaceVideo };
  }
  if (videoUrl) return { kind: "url", url: videoUrl };
  return { kind: "aiVideoEntry", entryId: aiVideoEntry! };
}

function resolveSink(
  args: Record<string, string | true>,
  source: VideoPortfolioSource,
): VideoPortfolioSink {
  const outDir = str(args["out-dir"]);
  const projectId = str(args.project);
  if (outDir && projectId && source.kind !== "workspace") {
    fail("Choose one output: --out-dir or --project.");
  }
  if (outDir) return createLocalDirSink(outDir);
  // A workspace input implies --project for the source; reuse it as the sink
  // unless an explicit --out-dir was given.
  if (source.kind === "workspace") return createWorkspaceSink(source.projectId);
  if (projectId) return createWorkspaceSink(projectId);
  // DB / URL videos default to a local directory so an Explore scan never
  // mutates live project_files before review.
  if (source.kind === "url" || source.kind === "aiVideoEntry") {
    const id = source.kind === "aiVideoEntry" ? source.entryId : "url";
    const defaultDir = path.resolve(`video-portfolio-out/${id}`);
    console.error(`No output specified; defaulting to --out-dir ${defaultDir}`);
    return createLocalDirSink(defaultDir);
  }
  fail("Provide an output: --out-dir <dir> or --project <id>.");
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const source = resolveSource(args);
  const sink = resolveSink(args, source);

  const analyzerArg = str(args.analyzer);
  if (analyzerArg && analyzerArg !== "openrouter" && analyzerArg !== "gemini") {
    fail(`--analyzer must be "openrouter" or "gemini" (got ${analyzerArg}).`);
  }

  const result = await runVideoPortfolioPipeline({
    source,
    sink,
    analyzer: analyzerArg as "openrouter" | "gemini" | undefined,
    model: str(args.model),
    maxEntities: str(args["max-entities"]) ? Number(args["max-entities"]) : undefined,
    maxPointsPerEntity: str(args["max-points"]) ? Number(args["max-points"]) : undefined,
    keepTempFiles: args["keep-temp"] === true,
    skipPortfolio: args["skip-portfolio"] === true,
    characterLedgerPath: str(args.ledger),
  });

  console.log(
    JSON.stringify(
      {
        source: result.sourceLabel,
        sink: sink.label,
        entities: result.plan.entities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          category: entity.referenceCategory,
          portfolioPath: entity.portfolioPath,
          contactSheetPath: entity.contactSheetPath,
        })),
        writtenPaths: result.writtenPaths,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
