import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Workflow recipes: loadable end-to-end production processes (inputs → plan
// template → method) the chat agent instantiates as a plan when a request
// matches one. Built-ins live in workflows/*.md at the repo root; users can
// save custom recipes into a project workspace at workflows/<slug>.md and the
// agent reads those with readFile.

export type WorkflowSummary = {
  category: string;
  description: string;
  id: string;
  path: string;
  title: string;
  use_when: string;
};

export type LoadedWorkflow = WorkflowSummary & {
  content: string;
};

/** Formats one resolved workflow for the companion request. Keeping this
 * boundary pure makes it explicit that the complete raw Markdown is appended
 * once, while the renderer sends only the stable workflow id. */
export function formatCompanionWorkflow(workflow: LoadedWorkflow) {
  return [
    `Selected workflow: ${workflow.title} (${workflow.id})`,
    "Apply this workflow without discarding the user's request or selected context:",
    workflow.content,
  ].join("\n");
}

export function isWorkflowLookupError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Invalid workflow id." ||
      error.message.startsWith("Workflow not found:"))
  );
}

const WORKFLOWS_ROOT = path.join(process.cwd(), "workflows");

function stripQuotes(value: string) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function yamlValue(frontmatter: string, key: string) {
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (match) return stripQuotes(match[1] ?? "");
  }
  return "";
}

function splitFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return { body: content, frontmatter: "" };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { body: content, frontmatter: "" };
  return {
    body: content.slice(end + 5).trimStart(),
    frontmatter: content.slice(4, end).trim(),
  };
}

async function readWorkflowFile(filePath: string): Promise<LoadedWorkflow> {
  const content = await readFile(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(content);
  const id =
    yamlValue(frontmatter, "name") ||
    path.basename(filePath).replace(/\.md$/, "");
  const description = yamlValue(frontmatter, "description");
  return {
    category: yamlValue(frontmatter, "category") || "General",
    content,
    description,
    id,
    path: path.relative(process.cwd(), filePath).replaceAll(path.sep, "/"),
    title: yamlValue(frontmatter, "title") || id,
    use_when: yamlValue(frontmatter, "use_when") || description || body.split("\n").find(Boolean) || "",
  };
}

async function findWorkflowFiles(): Promise<string[]> {
  const entries = await readdir(WORKFLOWS_ROOT, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(WORKFLOWS_ROOT, entry.name))
    .sort();
}

export async function listWorkflowSummaries(): Promise<WorkflowSummary[]> {
  const workflows = await Promise.all(
    (await findWorkflowFiles()).map((file) => readWorkflowFile(file)),
  );
  return workflows.map(({ content: _content, ...summary }) => summary);
}

export async function readWorkflow(workflowId: string): Promise<LoadedWorkflow> {
  const clean = workflowId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) throw new Error("Invalid workflow id.");
  const workflows = await Promise.all(
    (await findWorkflowFiles()).map((file) => readWorkflowFile(file)),
  );
  const workflow = workflows.find((candidate) => candidate.id === clean);
  if (!workflow) throw new Error(`Workflow not found: ${clean}`);
  return workflow;
}
