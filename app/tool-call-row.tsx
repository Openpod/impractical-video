import {
  BookOpen,
  CheckCircle2,
  Clapperboard,
  Eye,
  FilePen,
  FileText,
  Flag,
  Image as ImageIcon,
  Images,
  Link2,
  List,
  Search,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Presentational tool-call rows for the chat transcript. Each row is
 * `[icon] verb target · for Ns` and carries one of three states:
 *   - running (ok === undefined): red text + pulse, present-tense verb
 *   - done    (ok === true):      neutral text, past-tense verb + duration
 *   - failed  (ok === false):     red text, past-tense verb, no duration
 *
 * Duration comes from the persisted/live `durationMs` so the "for 2s" the user
 * watched survives a reload (the live and persisted paths share one shape).
 */

export type ToolCallView = {
  name: string;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
};

type Verbs = { running: string; done: string };

const VERBS: Record<string, Verbs> = {
  writeFile: { running: "Writing to", done: "Wrote" },
  patchFile: { running: "Patching", done: "Patched" },
  readFile: { running: "Reading", done: "Read" },
  listFiles: { running: "Listing files", done: "Listed files" },
  inspectFrontmatter: { running: "Inspecting", done: "Inspected" },
  webSearch: { running: "Searching web", done: "Searched web" },
  "openrouter.web_search": { running: "Searching web", done: "Searched web" },
  traceReferences: { running: "Tracing references", done: "Traced references" },
  searchImages: { running: "Searching images", done: "Searched images" },
  generateKeyframe: { running: "Generating keyframe", done: "Generated keyframe" },
  generateReferencePortfolio: { running: "Generating portfolio", done: "Generated portfolio" },
  prepareClipPrompts: { running: "Preparing clip prompts", done: "Prepared clip prompts" },
  generateClip: { running: "Generating clip", done: "Generated clip" },
  viewWorkspaceImage: { running: "Viewing image", done: "Viewed image" },
  viewImage: { running: "Viewing image", done: "Viewed image" },
  checkProject: { running: "Checking project", done: "Checked project" },
  reviewKeyframes: { running: "Reviewing keyframes", done: "Reviewed keyframes" },
  recordFinding: { running: "Recording finding", done: "Recorded finding" },
  resolveFinding: { running: "Resolving finding", done: "Resolved finding" },
  readSkill: { running: "Reading skill", done: "Read skill" },
  listSkills: { running: "Listing skills", done: "Listed skills" },
  loadWorkflow: { running: "Loading workflow", done: "Workflow loaded:" },
  splitClipsByShots: { running: "Splitting into shots", done: "Split into shots" },
  organizeCanvas: { running: "Organizing canvas", done: "Organized canvas" },
  generateSpeech: { running: "Generating speech", done: "Generated speech" },
  designVoice: { running: "Designing voice", done: "Designed voice" },
  generateMusic: { running: "Generating music", done: "Generated music" },
};

// Verb + noun used only when collapsing N adjacent calls into one row, e.g.
// `Viewed 10 images`. The noun is pluralized with a trailing "s".
const GROUP_VERBS: Record<string, Verbs> = {
  writeFile: { running: "Writing", done: "Wrote" },
  patchFile: { running: "Patching", done: "Patched" },
  readFile: { running: "Reading", done: "Read" },
  inspectFrontmatter: { running: "Inspecting", done: "Inspected" },
  webSearch: { running: "Searching", done: "Searched" },
  "openrouter.web_search": { running: "Searching", done: "Searched" },
  traceReferences: { running: "Tracing", done: "Traced" },
  searchImages: { running: "Searching", done: "Searched" },
  generateKeyframe: { running: "Generating", done: "Generated" },
  generateReferencePortfolio: { running: "Generating", done: "Generated" },
  prepareClipPrompts: { running: "Preparing", done: "Prepared" },
  generateClip: { running: "Generating", done: "Generated" },
  viewWorkspaceImage: { running: "Viewing", done: "Viewed" },
  viewImage: { running: "Viewing", done: "Viewed" },
  recordFinding: { running: "Recording", done: "Recorded" },
  resolveFinding: { running: "Resolving", done: "Resolved" },
  readSkill: { running: "Reading", done: "Read" },
  loadWorkflow: { running: "Loading", done: "Loaded" },
};

const GROUP_NOUNS: Record<string, string> = {
  writeFile: "file",
  patchFile: "file",
  readFile: "file",
  inspectFrontmatter: "file",
  webSearch: "web query",
  "openrouter.web_search": "web query",
  traceReferences: "reference",
  searchImages: "image query",
  generateKeyframe: "keyframe",
  generateReferencePortfolio: "portfolio",
  prepareClipPrompts: "prompt",
  generateClip: "clip",
  viewWorkspaceImage: "image",
  viewImage: "image",
  recordFinding: "finding",
  resolveFinding: "finding",
  readSkill: "skill",
  loadWorkflow: "workflow",
  splitClipsByShots: "clip",
};

const ICONS: Record<string, LucideIcon> = {
  writeFile: FilePen,
  patchFile: FilePen,
  readFile: FileText,
  listFiles: List,
  inspectFrontmatter: Search,
  webSearch: Search,
  "openrouter.web_search": Search,
  traceReferences: Link2,
  searchImages: Search,
  generateKeyframe: ImageIcon,
  viewWorkspaceImage: Eye,
  viewImage: Eye,
  generateReferencePortfolio: Images,
  prepareClipPrompts: FileText,
  generateClip: Clapperboard,
  checkProject: ShieldCheck,
  reviewKeyframes: CheckCircle2,
  recordFinding: Flag,
  resolveFinding: Flag,
  readSkill: BookOpen,
  listSkills: BookOpen,
  loadWorkflow: Wrench,
  splitClipsByShots: Clapperboard,
  organizeCanvas: List,
  generateSpeech: Clapperboard,
  designVoice: Clapperboard,
  generateMusic: Clapperboard,
};

function verbFor(name: string, running: boolean): string {
  const verbs = VERBS[name];
  if (verbs) return running ? verbs.running : verbs.done;
  return running ? `Running ${name}` : `Ran ${name}`;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  // One decimal under 10s, floored at 0.1s so a sub-100ms call still reads as
  // "0.1s" rather than "0.0s"; rounded whole seconds at 10s and above.
  return seconds < 10 ? `${Math.max(0.1, seconds).toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function RunningDuration() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = performance.now();
    const tick = () => setElapsedMs(performance.now() - startedAt);
    const interval = window.setInterval(tick, 100);
    return () => window.clearInterval(interval);
  }, []);

  return <span className="tool-call-dur">for {formatDuration(elapsedMs)}</span>;
}

function ToolCallRow({ call }: { call: ToolCallView }) {
  const running = call.ok === undefined;
  const failed = call.ok === false;
  const Icon = ICONS[call.name] ?? Wrench;
  const state = running ? "running" : failed ? "error" : "done";
  const label = verbFor(call.name, running);

  return (
    <div className={`tool-call ${state}`} title={call.summary}>
      <Icon className="tool-call-icon" size={13} strokeWidth={2} aria-hidden />
      <span className="tool-call-label">
        {label}
        {call.summary ? <span className="tool-call-target"> {call.summary}</span> : null}
      </span>
      {running ? <RunningDuration /> : null}
      {!running && !failed && call.durationMs != null ? (
        <span className="tool-call-dur">for {formatDuration(call.durationMs)}</span>
      ) : null}
    </div>
  );
}

function GroupedToolCallRow({ name, ok, calls }: { name: string; ok?: boolean; calls: ToolCallView[] }) {
  const running = ok === undefined;
  const failed = ok === false;
  const Icon = ICONS[name] ?? Wrench;
  const state = running ? "running" : failed ? "error" : "done";
  const count = calls.length;

  const verbs = GROUP_VERBS[name];
  const verb = verbs ? (running ? verbs.running : verbs.done) : running ? "Running" : "Ran";
  const noun = GROUP_NOUNS[name] ?? "call";
  const label = `${verb} ${count} ${noun}s`;

  // Calls run in parallel, so the longest one — not their sum — reflects the
  // group's elapsed time.
  const maxDuration = calls.reduce((max, call) => Math.max(max, call.durationMs ?? 0), 0);

  return (
    <div className={`tool-call ${state}`}>
      <Icon className="tool-call-icon" size={13} strokeWidth={2} aria-hidden />
      <span className="tool-call-label">{label}</span>
      {running ? <RunningDuration /> : null}
      {!running && !failed && maxDuration > 0 ? (
        <span className="tool-call-dur">for {formatDuration(maxDuration)}</span>
      ) : null}
    </div>
  );
}

type ToolGroup = { name: string; ok?: boolean; calls: ToolCallView[] };

/** Collapse runs of adjacent calls sharing the same name and state. */
function groupAdjacent(tools: ToolCallView[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const call of tools) {
    const last = groups[groups.length - 1];
    if (last && last.name === call.name && last.ok === call.ok) {
      last.calls.push(call);
    } else {
      groups.push({ name: call.name, ok: call.ok, calls: [call] });
    }
  }
  return groups;
}

export function ToolCallRows({ tools }: { tools?: ToolCallView[] }) {
  if (!tools?.length) return null;
  return (
    <>
      {groupAdjacent(tools).map((group, index) =>
        group.calls.length > 1 ? (
          <GroupedToolCallRow
            key={`${group.name}-${group.ok}-${index}`}
            name={group.name}
            ok={group.ok}
            calls={group.calls}
          />
        ) : (
          <ToolCallRow key={`${group.name}-${group.calls[0].summary ?? ""}-${index}`} call={group.calls[0]} />
        ),
      )}
    </>
  );
}
