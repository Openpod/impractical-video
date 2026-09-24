import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The development badge overlaps workspace controls on smaller windows.
  devIndicators: false,
  experimental: {
    // Preserve multipart bytes through middleware for Library (100 MB) and canvas (200 MB).
    proxyClientMaxBodySize: "201mb",
    // Client router cache for dynamic routes: hopping between open project
    // tabs within this window re-renders from the prefetched payload instead
    // of a full round-trip, so tab switches feel instant.
    staleTimes: { dynamic: 60, static: 300 },
  },
  serverExternalPackages: ["@fal-ai/client", "pdf-parse"],
  // The vendored opencut editor's transcription worker imports
  // @huggingface/transformers (Whisper) — that runs CLIENT-SIDE in a browser
  // web worker, never on the server. Next was tracing the ML packages (ONNX
  // native binaries + models, ~2GB) into serverless functions that never use
  // them, blowing past Vercel's function size limit. Exclude them from every
  // server function trace.
  outputFileTracingExcludes: {
    "*": [
      ".env*",
      "**/.env*",
      "**/providers.json",
      "**/providers.json.*.tmp",
      ".git/**",
      ".codex/**",
      ".agents/**",
      ".mcp.json",
      "*.tsbuildinfo",
      "node_modules/electron/**",
      "node_modules/electron-builder/**",
      "node_modules/electron-winstaller/**",
      "node_modules/app-builder-bin/**",
      "node_modules/app-builder-lib/**",
      "node_modules/@playwright/**",
      "node_modules/playwright*/**",
      "node_modules/@huggingface/**",
      "node_modules/onnxruntime-node/**",
      "node_modules/onnxruntime-web/**",
      "node_modules/onnxruntime-common/**",
      // Local dev data / experiment videos — must never be traced into
      // serverless functions (they ballooned every function to ~2GB).
      "data/**",
      "experiments/**",
      "stage-runs/**",
      "eval-runs/**",
      "eval-jobs/**",
      "tmp/**",
      "logs/**",
      "test-results/**",
      "playwright-report/**",
      "tests/**",
      "docs/**",
      "opencut-classic/**",
      "desktop/**",
    ],
  },
  outputFileTracingIncludes: {
    "/*": ["skills/**/*", "workflows/**/*", "scripts/video_tracking/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
