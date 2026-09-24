import { additionalFiles, aptGet, ffmpeg } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "proj_video_fs_agent_local",
  runtime: "node",
  logLevel: "log",
  maxDuration: 36000,
  retries: {
    enabledInDev: false,
  },
  dirs: ["./src/trigger"],
  build: {
    autoDetectExternal: true,
    extensions: [
      additionalFiles({ files: ["skills/**/*.md", "workflows/**/*.md", "scripts/video_tracking/**/*.py"] }),
      aptGet({ packages: ["python3", "python3-opencv", "yt-dlp"] }),
      ffmpeg(),
    ],
  },
});
