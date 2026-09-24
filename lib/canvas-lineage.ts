import { parseJsonFrontmatter } from "@/lib/workspace";
import { isProjectSupportMetadataPath } from "@/lib/project-file-classification";

// Derived lineage view over the canvas DAG. The graph is never stored — it is
// recomputed from the provenance frontmatter that artifacts already carry
// (canvas_derived_from, depicts, captured_from, from/to_keyframe,
// state_anchor, canvas_group). One source of truth, many views.

export type LineageEdge = {
  from: string;
  to: string;
  via:
    | "captured_from"
    | "depicts"
    | "derived_from"
    | "from_keyframe"
    | "group_sibling"
    | "state_anchor"
    | "to_keyframe";
};

export type LineageNode = {
  group: string | null;
  id: string;
  kind: string;
  path: string;
  title: string;
};

export type LineageIndex = {
  edges: LineageEdge[];
  nodes: Map<string, LineageNode>;
};

function firstHeading(body: string, fallback: string) {
  return (
    body
      .split("\n")
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() || fallback
  );
}

function kindForPath(path: string) {
  if (path.startsWith("clips/")) return "clip";
  if (path.startsWith("keyframes/")) return "image";
  if (path.startsWith("uploads/")) return "upload";
  if (path.startsWith("references/")) return "reference";
  return "node";
}

export function buildLineageIndex(
  files: Array<{ content?: string | null; path: string }>,
): LineageIndex {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const pushEdge = (from: unknown, to: string, via: LineageEdge["via"]) => {
    if (typeof from === "string" && from && from !== to) edges.push({ from, to, via });
  };

  for (const file of files) {
    if (isProjectSupportMetadataPath(file.path)) continue;
    if (typeof file.content !== "string") continue;
    const isNode =
      /^(clips|keyframes|uploads)\/[^/]+\.md$/.test(file.path) ||
      /^references\/[^/]+\/[^/]+\/reference\.md$/.test(file.path);
    if (!isNode) continue;
    const parsed = parseJsonFrontmatter(file.content);
    const meta = parsed.meta;
    if (typeof meta.id !== "string") continue;
    if (meta.status === "rejected" || meta.status === "superseded") continue;
    const id = meta.id;
    nodes.set(id, {
      group: typeof meta.canvas_group === "string" ? meta.canvas_group : null,
      id,
      kind: kindForPath(file.path),
      path: file.path,
      title: firstHeading(parsed.body, id),
    });
    pushEdge(meta.canvas_derived_from, id, "derived_from");
    pushEdge(meta.captured_from, id, "captured_from");
    pushEdge(meta.from_keyframe, id, "from_keyframe");
    pushEdge(meta.to_keyframe, id, "to_keyframe");
    pushEdge(meta.state_anchor, id, "state_anchor");
    if (Array.isArray(meta.depicts)) {
      for (const dep of meta.depicts) pushEdge(dep, id, "depicts");
    }
  }
  return { edges, nodes };
}

export type LineageTrace = {
  ancestors: Array<{ hops: number; id: string; kind: string; title: string; via: string }>;
  descendants: Array<{ hops: number; id: string; kind: string; title: string; via: string }>;
  group_siblings: Array<{ id: string; kind: string; title: string }>;
  id: string;
};

/** Ancestors (what this came from) and descendants (what was made from it),
 * breadth-first with hop counts, plus canvas-group siblings. */
export function traceLineage(index: LineageIndex, id: string): LineageTrace | null {
  const node = index.nodes.get(id);
  if (!node) return null;

  const walk = (direction: "up" | "down") => {
    const results: LineageTrace["ancestors"] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    let hops = 0;
    while (frontier.length && hops < 12) {
      hops += 1;
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of index.edges) {
          const [neighbor, via] =
            direction === "up" && edge.to === current
              ? [edge.from, edge.via]
              : direction === "down" && edge.from === current
                ? [edge.to, edge.via]
                : [null, null];
          if (!neighbor || seen.has(neighbor)) continue;
          seen.add(neighbor);
          const info = index.nodes.get(neighbor);
          results.push({
            hops,
            id: neighbor,
            kind: info?.kind ?? "node",
            title: info?.title ?? neighbor,
            via: via!,
          });
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return results;
  };

  const group_siblings = node.group
    ? [...index.nodes.values()]
        .filter((entry) => entry.group === node.group && entry.id !== id)
        .map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title }))
    : [];

  return { ancestors: walk("up"), descendants: walk("down"), group_siblings, id };
}

/** Deterministic continuity advisory: a video generated with no visual link
 * to any existing material, in a project that has footage, deserves a note. */
export function unlinkedGenerationNote(
  index: LineageIndex,
  conditionedOnIds: string[],
): string | null {
  if (conditionedOnIds.length) return null;
  const hasFootage = [...index.nodes.values()].some(
    (node) => node.kind === "clip" || node.kind === "upload",
  );
  if (!hasFootage) return null;
  return "Note: this video was generated from text alone, with no visual link to any existing clip or upload. If it should continue or match existing footage, extract that footage's final frame (extractFrame) or pass reference ids so the connection is real, not implied.";
}

/** The aspect ratio the project is actually working in: the most common
 * declared ratio across active clips and keyframes (ties → most recent).
 * Computed, not model-chosen — generations must not drift from it. */
export function dominantAspectRatio(
  files: Array<{ content?: string | null; path: string }>,
): string | null {
  const votes = new Map<string, { count: number; latest: number }>();
  for (const file of files) {
    if (typeof file.content !== "string") continue;
    if (!/^(clips|keyframes)\/[^/]+\.md$/.test(file.path)) continue;
    const parsed = parseJsonFrontmatter(file.content);
    if (parsed.meta.status === "rejected" || parsed.meta.status === "superseded") continue;
    const aspect = typeof parsed.meta.aspect_ratio === "string" ? parsed.meta.aspect_ratio : null;
    if (!aspect) continue;
    const index = typeof parsed.meta.index === "number" ? parsed.meta.index : 0;
    const entry = votes.get(aspect) ?? { count: 0, latest: 0 };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, index);
    votes.set(aspect, entry);
  }
  let winner: string | null = null;
  let best = { count: 0, latest: -1 };
  for (const [aspect, entry] of votes) {
    if (entry.count > best.count || (entry.count === best.count && entry.latest > best.latest)) {
      winner = aspect;
      best = entry;
    }
  }
  return winner;
}
