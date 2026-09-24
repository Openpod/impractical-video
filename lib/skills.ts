import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type SkillSummary = {
  description: string;
  id: string;
  path: string;
  tags: string[];
  use_when_summary: string;
};

export type LoadedSkill = SkillSummary & {
  content: string;
};

const SKILLS_ROOT = path.join(process.cwd(), "skills");

function stripQuotes(value: string) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseStringList(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

function yamlValue(frontmatter: string, key: string) {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[index] ?? "");
    if (!match) continue;
    const raw = match[1] ?? "";
    const marker = raw.trim();
    if (marker === ">-" || marker === ">" || marker === "|-" || marker === "|") {
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? "";
        if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
        block.push(line.replace(/^ {2}/, ""));
      }
      if (marker.startsWith(">")) {
        return block.map((line) => line.trim()).join(" ").replace(/\s+/g, " ").trim();
      }
      return block.join("\n").trim();
    }
    return stripQuotes(raw);
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

async function findSkillFiles(dir = SKILLS_ROOT): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(fullPath)));
    } else if (entry.name === "SKILL.md" || entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function skillIdFromPath(filePath: string) {
  const relative = path.relative(SKILLS_ROOT, filePath).replaceAll(path.sep, "/");
  if (path.basename(relative) === "SKILL.md") return path.dirname(relative).replaceAll("/", "-");
  return relative.replace(/\.md$/, "").replaceAll("/", "-");
}

async function readSkillFile(filePath: string): Promise<LoadedSkill> {
  const content = await readFile(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(content);
  const id = yamlValue(frontmatter, "name") || skillIdFromPath(filePath);
  const description = yamlValue(frontmatter, "description");
  const use_when_summary = yamlValue(frontmatter, "use_when_summary") || description || body.split("\n").find(Boolean) || "";
  const tags = parseStringList(yamlValue(frontmatter, "tags"));
  return {
    content,
    description,
    id,
    path: path.relative(process.cwd(), filePath).replaceAll(path.sep, "/"),
    tags,
    use_when_summary,
  };
}

export async function listSkillSummaries(): Promise<SkillSummary[]> {
  const skills = await Promise.all((await findSkillFiles()).map((file) => readSkillFile(file)));
  return skills.map(({ content: _content, ...summary }) => summary);
}

export async function readSkill(skillId: string): Promise<LoadedSkill> {
  const clean = skillId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) throw new Error("Invalid skill id.");
  const skills = await Promise.all((await findSkillFiles()).map((file) => readSkillFile(file)));
  const skill = skills.find((candidate) => candidate.id === clean);
  if (!skill) throw new Error(`Skill not found: ${clean}`);
  return skill;
}
