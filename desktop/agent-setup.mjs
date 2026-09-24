import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProjectId } from "./project-binding.mjs";

const GUIDE_NAME = "VIDEO_FS_AGENT_GUIDE.md";

export function projectIdFromAppUrl(candidate, appUrl) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.origin !== new URL(appUrl).origin) return null;
  const match = url.pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return validateProjectId(decodeURIComponent(match[1]), "project id");
  } catch {
    return null;
  }
}

export async function setupAgentProject({ projectId: rawProjectId, state }) {
  const projectId = validateProjectId(rawProjectId, "project id");
  const projectRoot = await resolveProjectRoot(state.dataRoot, projectId);
  const codexProjectRoot = await ensureCodexProjectRoot(projectRoot);
  const launcher = launcherForProject(state.mcp, projectId);
  const claudeHookLauncher = contextHookLauncherForProject(
    state.mcp,
    projectId,
    "claude",
  );
  const codexHookLauncher = contextHookLauncherForProject(
    state.mcp,
    projectId,
    "codex",
  );
  const claudeConfig = `${JSON.stringify(
    {
      mcpServers: {
        "video-fs": {
          args: launcher.args,
          command: launcher.command,
          type: "stdio",
        },
      },
    },
    null,
    2,
  )}\n`;
  const codexConfig = [
    "[mcp_servers.video-fs]",
    `command = ${tomlString(launcher.command)}`,
    `args = ${tomlStringArray(launcher.args)}`,
    "",
  ].join("\n");
  const claudeHookConfig = hookConfig(claudeHookLauncher);
  const codexHookConfig = hookConfig(codexHookLauncher);
  const guide = agentGuide(projectId, codexProjectRoot);

  for (const output of [
    claudeConfig,
    claudeHookConfig,
    codexConfig,
    codexHookConfig,
    guide,
  ]) {
    assertTokenFree(output, state.token);
  }

  await Promise.all([
    mkdir(path.join(projectRoot, ".claude"), { mode: 0o700, recursive: true }),
    mkdir(path.join(projectRoot, ".codex"), { mode: 0o700, recursive: true }),
  ]);
  await syncProjectSkills(projectRoot);
  const claudeResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, ".mcp.json"),
    claudeConfig,
  );
  const codexResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, ".codex", "config.toml"),
    codexConfig,
  );
  const claudeHookResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, ".claude", "settings.json"),
    claudeHookConfig,
  );
  await enableProjectMcpServers(path.join(projectRoot, ".claude", "settings.json"));
  const codexHookResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, ".codex", "hooks.json"),
    codexHookConfig,
  );
  const claudeGuideResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, "CLAUDE.md"),
    guide,
  );
  const codexGuideResult = await writePrivateFileIfAbsent(
    path.join(projectRoot, "AGENTS.md"),
    guide,
  );

  const supportDirectory = path.join(projectRoot, ".video-fs");
  await mkdir(supportDirectory, { mode: 0o700, recursive: true });
  const fallbackGuide = connectionGuide({
    claudeConflict: claudeResult.status === "conflict",
    claudeHookConflict: claudeHookResult.status === "conflict",
    codexProjectRoot,
    codexConflict: codexResult.status === "conflict",
    codexHookConflict: codexHookResult.status === "conflict",
    launcher,
    projectId,
  });
  assertTokenFree(fallbackGuide, state.token);
  const supportResults = await Promise.all([
    writePrivateFileIfAbsent(
      path.join(supportDirectory, "claude.mcp.json"),
      claudeConfig,
    ),
    writePrivateFileIfAbsent(
      path.join(supportDirectory, "codex.config.toml"),
      codexConfig,
    ),
    writePrivateFileAtomic(
      path.join(supportDirectory, "CONNECT_AGENTS.md"),
      fallbackGuide,
    ),
    // App-owned and always refreshed: guide improvements must reach existing
    // projects even though CLAUDE.md/AGENTS.md (user-editable) are preserved.
    writePrivateFileAtomic(path.join(projectRoot, GUIDE_NAME), guide),
    writeConflictCopy(
      supportDirectory,
      "claude-settings",
      claudeHookConfig,
      claudeHookResult.status === "conflict",
    ),
    writeConflictCopy(
      supportDirectory,
      "codex-hooks",
      codexHookConfig,
      codexHookResult.status === "conflict",
    ),
  ]);

  return {
    conflicts: [
      ...(claudeResult.status === "conflict" ? [".mcp.json"] : []),
      ...(codexResult.status === "conflict" ? [".codex/config.toml"] : []),
      ...(claudeHookResult.status === "conflict"
        ? [".claude/settings.json"]
        : []),
      ...(codexHookResult.status === "conflict"
        ? [".codex/hooks.json"]
        : []),
      ...(claudeGuideResult.status === "conflict" ? ["CLAUDE.md"] : []),
      ...(codexGuideResult.status === "conflict" ? ["AGENTS.md"] : []),
    ],
    created: [
      ...createdPath(claudeResult, ".mcp.json"),
      ...createdPath(codexResult, ".codex/config.toml"),
      ...createdPath(claudeHookResult, ".claude/settings.json"),
      ...createdPath(codexHookResult, ".codex/hooks.json"),
      ...createdPath(claudeGuideResult, "CLAUDE.md"),
      ...createdPath(codexGuideResult, "AGENTS.md"),
      ...createdPath(supportResults[0], ".video-fs/claude.mcp.json"),
      ...createdPath(supportResults[1], ".video-fs/codex.config.toml"),
      ...createdPath(supportResults[2], ".video-fs/CONNECT_AGENTS.md"),
      ...createdPath(supportResults[3], GUIDE_NAME),
      ...supportCreatedPath(projectRoot, supportResults[4]),
      ...supportCreatedPath(projectRoot, supportResults[5]),
    ],
    projectId,
    projectRoot,
    codexProjectRoot,
  };
}

async function ensureCodexProjectRoot(projectRoot) {
  const marker = path.join(projectRoot, ".git");
  const existing = await lstat(marker).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    return { status: "existing" };
  }

  try {
    await runGit([
      "-C",
      projectRoot,
      "init",
      "--quiet",
      "--initial-branch=main",
    ]);
    return { status: "created" };
  } catch {
    // Claude setup and the token-free MCP launcher remain useful without Git.
    // Codex cannot discover project-local config until a supported root marker
    // exists, so surface that state in the generated guidance instead of
    // failing all agent setup.
    return { status: "unavailable" };
  }
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL:
          process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Git initialization ended after signal ${signal}.`
            : `Git initialization exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function resolveProjectRoot(dataRoot, projectId) {
  const root = await realpath(path.resolve(dataRoot));
  const candidate = path.join(root, projectId);
  await access(path.join(candidate, "project.json"));
  const resolved = await realpath(candidate);
  if (path.dirname(resolved) !== root) {
    throw new Error("Project resolved outside the desktop project root.");
  }
  return resolved;
}

function launcherForProject(mcp, projectId) {
  if (!mcp || !path.isAbsolute(mcp.command) || !Array.isArray(mcp.args)) {
    throw new Error("Desktop MCP launcher is invalid.");
  }
  return {
    args: [...mcp.args, "--project-id", projectId],
    command: mcp.command,
  };
}

function contextHookLauncherForProject(mcp, projectId, agent) {
  if (!mcp || !path.isAbsolute(mcp.command) || !Array.isArray(mcp.args)) {
    throw new Error("Desktop context launcher is invalid.");
  }
  const modeIndex = mcp.args.indexOf("--mcp");
  if (modeIndex < 0) {
    throw new Error("Desktop context launcher is missing its MCP mode.");
  }
  return {
    args: [
      ...mcp.args.slice(0, modeIndex),
      "--agent-context-hook",
      ...mcp.args.slice(modeIndex + 1),
      "--agent",
      agent,
      "--project-id",
      projectId,
    ],
    command: mcp.command,
  };
}

function hookConfig(launcher) {
  const command = [launcher.command, ...launcher.args]
    .map(shellQuote)
    .join(" ");
  return `${JSON.stringify(
    {
      // Auto-trust the project's own .mcp.json so users never see the CLI's
      // interactive "approve this MCP server" prompt — the desktop wrote that
      // config itself, so approval is implicit. Current Claude releases need
      // the explicit server allowlist even when the blanket legacy flag is set.
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["video-fs"],
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                command,
                timeout: 5,
                type: "command",
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/** Existing projects may predate the explicit MCP server allowlist. Merge it
 * in ONLY when the settings file is our own earlier output (identified by the
 * desktop's context-hook command) — user-authored settings are never touched,
 * matching the preservation contract. */
async function enableProjectMcpServers(settingsPath) {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const enabledServers = Array.isArray(parsed.enabledMcpjsonServers)
      ? parsed.enabledMcpjsonServers.filter(
          (server) => typeof server === "string",
        )
      : [];
    if (
      parsed.enableAllProjectMcpServers === true &&
      enabledServers.includes("video-fs")
    ) {
      return;
    }
    const keys = Object.keys(parsed);
    const appOwned =
      keys.every(
        (key) =>
          key === "hooks" ||
          key === "enableAllProjectMcpServers" ||
          key === "enabledMcpjsonServers",
      ) &&
      JSON.stringify(parsed.hooks ?? {}).includes("--agent-context-hook");
    if (!appOwned) return;
    parsed.enableAllProjectMcpServers = true;
    parsed.enabledMcpjsonServers = [...new Set([...enabledServers, "video-fs"])];
    await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Missing or hand-mangled settings stay untouched.
  }
}

async function writePrivateFileIfAbsent(filePath, contents) {
  const existing = await readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    return { path: filePath, status: existing === contents ? "unchanged" : "conflict" };
  }

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    // A hard link is an atomic create-if-absent operation. Unlike rename(), it
    // cannot replace a config another process created after our initial read.
    await link(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    return { path: filePath, status: "created" };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const racedContents = await readFile(filePath, "utf8");
    return {
      path: filePath,
      status: racedContents === contents ? "unchanged" : "conflict",
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writePrivateFileAtomic(filePath, contents) {
  const existing = await readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing === contents) {
    return { path: filePath, status: "unchanged" };
  }
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    return {
      path: filePath,
      status: existing === null ? "created" : "updated",
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writeConflictCopy(
  supportDirectory,
  label,
  contents,
  conflict,
) {
  if (!conflict) return null;
  const digest = createHash("sha256").update(contents).digest("hex").slice(0, 12);
  const directory = path.join(supportDirectory, "conflicts");
  await mkdir(directory, { mode: 0o700, recursive: true });
  return writePrivateFileIfAbsent(
    path.join(directory, `${label}-video-fs-${digest}.json`),
    contents,
  );
}

/** Mirrors the app's method skills into the project so Claude Code discovers
 * them natively (SKILL.md files under `.claude/skills/`) and Codex can read
 * them by path. App-owned method files: refreshed on every setup. */
async function syncProjectSkills(projectRoot) {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sourceCandidates = [
    // electron-builder ships app-owned skills beside app.asar so they remain
    // ordinary files that can be mirrored into every opened project.
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "skills")
      : null,
    // Development and the standalone setup helper read from the repo root.
    path.resolve(moduleDirectory, "..", "skills"),
  ].filter(Boolean);
  let sourceDirectory = null;
  for (const candidate of sourceCandidates) {
    try {
      await access(candidate);
      sourceDirectory = candidate;
      break;
    } catch {
      // Keep looking: packaged and development layouts intentionally differ.
    }
  }
  if (!sourceDirectory) return;
  try {
    // Remove the retired bundled skill from existing projects, while preserving
    // user-edited copies and any additional files in that directory.
    const retired = path.join(projectRoot, ".claude", "skills", "adult-glamour-portfolio", "SKILL.md");
    const previous = await readFile(retired).catch(() => null);
    if (previous && createHash("sha256").update(previous).digest("hex") === "b9b043195f2d26845c8b2c72cd28da96cccf45f8661348a60f51b96b310e1583") {
      await rm(retired);
    }
    await cp(sourceDirectory, path.join(projectRoot, ".claude", "skills"), {
      force: true,
      recursive: true,
    });
  } catch (error) {
    console.error(
      `[desktop] could not sync skills: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function agentGuide(projectId, codexProjectRoot) {
  return [
    "# Video FS agent project",
    "",
    `This directory is Video FS project \`${projectId}\`.`,
    "",
    "Use the `video-fs` MCP tools for project operations and run `check_project`",
    "after graph or dependency changes. MCP operations are mechanically confined",
    "to this one project by the desktop bridge.",
    "",
    `The canonical, always-current copy of this guide is \`${GUIDE_NAME}\` in`,
    "this directory — if this file and that one disagree, that one wins.",
    "",
    "## Project naming",
    "",
    "If `project.json` still has the placeholder name (\"Untitled video\"),",
    "OR the name is just the user's first message pasted verbatim (the app",
    "stamps that as a stopgap), rename it on the first real task: edit its",
    "`name` field to a short, specific TITLE derived from what the user",
    "asked for (e.g. \"Three Women on the Beach\") — a title, never a",
    "sentence or instruction. Do this once, without asking.",
    "",
    "## Files vs tools",
    "",
    "Tools exist only for operations the app must execute (ffmpeg, generation",
    "providers, the editor command document). Metadata changes are plain file",
    "edits in this directory — the canvas watches and refreshes:",
    "",
    "- Rename a tile: rewrite its `# Title` heading in the markdown record.",
    "- Delete a tile: set frontmatter `status` to `\"rejected\"`.",
    "- Grouping intent: write `canvas/groups.json` (`{groups:[{id,cardIds,title}]}`).",
    "  KEEP THE CANVAS ORGANIZED: whenever you add a batch of related tiles",
    "  (pulled reference photos, style stills, a set of uploads), group them",
    "  with a clear title — e.g. separate groups for \"Sports players\",",
    "  \"MAPPA style refs\". Generated references auto-group by category;",
    "  uploads only group if you write them into groups.json.",
    "- Provenance/lineage: read `derived_from` / `canvas_derived_from` frontmatter.",
    "",
    "After hand-editing records, run `check_project`.",
    "",
    "## Skills",
    "",
    "Method skills live in `.claude/skills/` (Claude Code discovers them",
    "automatically; from Codex, read the `SKILL.md` directly). Load the named",
    "skill BEFORE the step that calls for it:",
    "",
    "- Taking on ANY generation task involving a character, environment, prop,",
    "  or style that could recur → `reference-first-production` FIRST. It is",
    "  the intake method: references and portfolios are created before scenes,",
    "  keyframes, or clips derive from them.",
    "- Before writing ANY generation prompt (image, clip, or audio) →",
    "  `model-prompting`. It documents what each model behind the tools",
    "  actually rewards — Seedance 2.0 shot grammar and @Video extension",
    "  phrasing, Nano Banana 2 brief structure, edit keep-clauses, ElevenLabs",
    "  voice/music/SFX shapes.",
    "- The user wants images/video from the internet on the canvas (style",
    "  references, moodboards, \"pull this URL in\") → `internet-style-references`.",
    "  Fetching web media as reference tiles is a supported, normal operation —",
    "  do it, don't refuse.",
    "- Planning ANY production video that tells a story or depicts a world —",
    "  characters, a setting, or a sequence of shots → `directors-notebook`",
    "  first, before writing scenes, shot plans, or keyframes.",
    "",
    "## Character design",
    "",
    "Follow the user's requested appearance, body type, wardrobe, and style.",
    "Keep that identity consistent across references and generated scenes.",
    "",
    "## Tool families",
    "",
    "PROMPTS ARE PLAIN PROSE: never send markdown into a generation prompt —",
    "no `##` headings, bullets, backticks, or links. Reference documents are",
    "markdown; prompts distilled FROM them are flowing descriptive sentences.",
    "Markdown artifacts in provider prompts have unknown effects on quality.",
    "",
    "GROUND CLIPS IN THE REFERENCES — but choose the method per shot.",
    "Text-only clips ignore every reference (identity drifts, no lineage).",
    "Choose the lightest method that delivers the user's requested outcome.",
    "Direct creations and edits do not need a formal workflow. For genuinely",
    "multi-stage work, use `load_workflow` only when one recipe is a strong",
    "semantic match, adapt its useful steps, and keep executing. Never ask the",
    "user to choose a workflow or force their request into a weak match.",
    "",
    "- Orchestration: `load_workflow` for a strongly matched complex request.",
    "- Generation: `generate_image`, `generate_clip`, `generate_audio`",
    "  (music | speech | sfx | voice_design), plus `create_scene` and",
    "  `scaffold_keyframe` for planning records.",
    "- Canvas media edits: `edit_media` (trim | crop_filters | extract_frame) —",
    "  the same ffmpeg paths and versioning the app's own drawer uses.",
    "- Editor: `editor_timeline_get` to read (always read before mutating), then",
    "  `editor_edit` for element mutations (insert, insert_text, update — params",
    "  like volume/opacity/transform/text styling — move, trim, split, remove,",
    "  duplicate, separate_audio) and `editor_structure` for tracks, scenes,",
    "  bookmarks, settings, and undo. Every mutation needs the current editor",
    "  revision and an idempotency key; receipts return the new revision.",
    "",
    "The desktop MVP supports one external agent process per project. Separate",
    "agents may work in separate projects at the same time, but do not connect",
    "multiple Claude or Codex processes to this same project: same-project",
    "conflict resolution is not supported.",
    "",
    "The terminal agent itself is not mechanically confined by Video FS. Claude",
    "Code and Codex inherit the filesystem permissions and sandbox settings of",
    "their own process. Do not read, write, move, or delete files outside this",
    "opened project unless the user explicitly asks.",
    "",
    "Keep Video FS Desktop open while using the MCP tools. If the app restarts,",
    "reconnect or restart the agent session so the launcher reads fresh runtime",
    "connection state.",
    "",
    ...(codexProjectRoot.status === "unavailable"
      ? [
          "Codex project discovery is unavailable because Video FS could not",
          "initialize this folder as a local Git worktree. Install Git, reopen",
          "this project in Video FS, then start Codex normally from this folder.",
          "",
        ]
      : [
          "Video FS initialized this folder as a local Git worktree so normal",
          "Codex project discovery works without flags. No commit or remote was",
          "created. On first launch, review and accept Codex's project trust",
          "prompt, then use `/hooks` to review and trust the Video FS context hook.",
          "",
        ]),
  ].join("\n");
}

function connectionGuide({
  claudeConflict,
  claudeHookConflict,
  codexProjectRoot,
  codexConflict,
  codexHookConflict,
  launcher,
  projectId,
}) {
  const claudeCommand = [
    "claude",
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "project",
    "video-fs",
    "--",
    launcher.command,
    ...launcher.args,
  ]
    .map(shellQuote)
    .join(" ");
  return [
    "# Connect Claude Code or Codex",
    "",
    `Video FS Desktop prepared token-free MCP configuration for project \`${projectId}\`.`,
    "Keep the desktop app open, open a terminal in this project directory, and",
    "start `claude` or `codex`.",
    "",
    "Use at most one external agent process for this project. Separate projects",
    "may have separate agents concurrently; same-project conflict resolution is",
    "not supported in the desktop MVP.",
    "",
    "Claude Code discovers `.mcp.json` and asks you to approve the project MCP",
    "server the first time. Video FS initializes a local Git worktree so normal",
    "Codex discovers `.codex/config.toml` without flags.",
    "",
    ...(claudeConflict
      ? [
          "An existing `.mcp.json` was preserved byte-for-byte. Review",
          "`.video-fs/claude.mcp.json`, then explicitly run:",
          "",
          "```sh",
          claudeCommand,
          "```",
          "",
        ]
      : []),
    ...(codexConflict
      ? [
          "An existing `.codex/config.toml` was preserved byte-for-byte. Review",
          "`.video-fs/codex.config.toml` and merge the `video-fs` MCP entry.",
          "Video FS never rewrites an existing Codex configuration.",
          "",
        ]
      : [
          "Start Codex normally from this folder. No Git initialization,",
          "`--skip-git-repo-check`, or one-session config flags are required.",
          "",
        ]),
    ...(claudeHookConflict
      ? [
          "An existing `.claude/settings.json` was preserved byte-for-byte.",
          "Review the generated Video FS hook under `.video-fs/conflicts/` and",
          "merge its `UserPromptSubmit` entry yourself. Claude will ask you to",
          "trust the project hook before it can inject selection context.",
          "Until it is merged and trusted, prompts continue normally with no",
          "Video FS context.",
          "",
        ]
      : [
          "Claude will ask you to trust the generated project hook. Until you",
          "approve it, prompts continue normally and no Video FS context is injected.",
          "",
        ]),
    ...(codexHookConflict
      ? [
          "An existing `.codex/hooks.json` was preserved byte-for-byte. Review",
          "the generated Video FS hook under `.video-fs/conflicts/` and merge its",
          "`UserPromptSubmit` entry yourself.",
          "Until it is merged and trusted, prompts continue normally with no",
          "Video FS context.",
          "",
        ]
      : [
          "Codex requires one-time project trust and hook trust by design. Accept",
          "the project trust prompt, then use `/hooks` to review and trust the",
          "generated command. Pending hooks are skipped, so prompts continue",
          "without Video FS context until approval.",
          "",
        ]),
    "These files and commands contain no bearer token. The installed Video FS",
    "launcher securely reads the current mode-0600 desktop connection record on",
    "every prompt. Offline or changed connections fail open without reusing a",
    "cached selection.",
    "",
    agentGuide(projectId, codexProjectRoot),
  ].join("\n");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function assertTokenFree(value, token) {
  if (token && value.includes(token)) {
    throw new Error("Refusing to write a desktop bearer token into agent configuration.");
  }
}

function createdPath(result, relativePath) {
  return result.status === "created" ? [relativePath] : [];
}

function supportCreatedPath(projectRoot, result) {
  if (!result || result.status !== "created") return [];
  return [path.relative(projectRoot, result.path).split(path.sep).join("/")];
}
