import { Fragment, type ReactNode } from "react";

/**
 * A small, dependency-free markdown renderer for assistant chat output.
 *
 * It builds React nodes directly (never dangerouslySetInnerHTML), so even
 * untrusted text can't inject markup — links are the only element that carry a
 * URL, and they open with rel="noreferrer". The grammar is deliberately
 * conservative: headings, ordered/unordered lists, blockquotes, fenced code,
 * and inline code / bold / italic / links / resolved refs. Anything it doesn't
 * recognize falls through as a plain paragraph, so output is never lost.
 */

const INLINE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(@\[[A-Za-z0-9_-]+\]|@?[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9][A-Za-z0-9_-]*)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;

export type RefKind = "clip" | "keyframe" | "reference";

export interface RefEntry {
  id: string;
  kind: RefKind | (string & {});
  path?: string;
  posterUrl?: string | null;
  thumbUrl?: string | null;
  title: string;
}

export type RefResolver = (id: string) => RefEntry | null | undefined;
export type RenderMention = (entry: RefEntry, token: string) => ReactNode;

interface InlineOptions {
  refResolver?: RefResolver;
  renderMention?: RenderMention;
}

const REF_CANDIDATE =
  /@\[([A-Za-z0-9_-]+)\]|@([A-Za-z][A-Za-z0-9_-]*_[A-Za-z0-9_-]+)|\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9][A-Za-z0-9_-]*)\b/g;

function isRefCandidate(value: string) {
  REF_CANDIDATE.lastIndex = 0;
  const ok = REF_CANDIDATE.test(value);
  REF_CANDIDATE.lastIndex = 0;
  return ok;
}

function hasResolvedRef(value: string, opts: InlineOptions) {
  if (!opts.refResolver) return false;
  REF_CANDIDATE.lastIndex = 0;
  for (const match of value.matchAll(REF_CANDIDATE)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id && opts.refResolver(id)) return true;
  }
  return false;
}

function stripReferenceMarkdownWrappers(text: string, opts: InlineOptions) {
  if (!opts.refResolver) return text;
  const withoutRefCode = text.replace(/`([^`\n]+)`/g, (token, content: string) =>
    hasResolvedRef(content, opts) ? content : token,
  );
  return withoutRefCode.replace(/(\*\*|__)([\s\S]+?)\1/g, (token, _marker: string, content: string) =>
    hasResolvedRef(content, opts) ? content : token,
  );
}

function renderMention(entry: RefEntry, token: string, key: string, opts: InlineOptions) {
  if (opts.renderMention) {
    return <Fragment key={key}>{opts.renderMention(entry, token)}</Fragment>;
  }
  return (
    <span
      key={key}
      className="md-ref-chip"
      data-ref-id={entry.id}
      data-ref-kind={entry.kind}
      data-ref-path={entry.path}
      title={entry.id}
    >
      {entry.title}
    </span>
  );
}

function renderRefsInText(text: string, keyPrefix: string, opts: InlineOptions) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let count = 0;

  REF_CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(REF_CANDIDATE)) {
    const token = match[0];
    const index = match.index ?? 0;
    const id = match[1] ?? match[2] ?? match[3];
    const entry = id ? opts.refResolver?.(id) : null;
    if (!entry) continue;

    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(renderMention(entry, token, `${keyPrefix}-ref-${count++}`, opts));
    cursor = index + token.length;
  }

  if (!count) return null;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderInlineCode(token: string, key: string, opts: InlineOptions) {
  const content = token.slice(1, -1);
  const refs = renderRefsInText(content, `${key}-code`, opts);
  if (refs) {
    return (
      <span key={key} className="md-ref-code">
        {refs}
      </span>
    );
  }
  return (
    <code key={key} className="md-code">
      {content}
    </code>
  );
}

function renderInline(text: string, keyPrefix: string, opts: InlineOptions = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = stripReferenceMarkdownWrappers(text, opts);
  let i = 0;
  while (rest.length) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(...(renderRefsInText(rest, `${keyPrefix}-tail`, opts) ?? [rest]));
      break;
    }
    if (match.index > 0) {
      const before = rest.slice(0, match.index);
      nodes.push(...(renderRefsInText(before, `${keyPrefix}-${i}-before`, opts) ?? [before]));
    }
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("`")) {
      nodes.push(renderInlineCode(token, key, opts));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a key={key} className="md-link" href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (isRefCandidate(token)) {
      nodes.push(...(renderRefsInText(token, key, opts) ?? [token]));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key, opts)}</strong>);
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key, opts)}</em>);
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

const isFence = (line: string) => /^```/.test(line.trim());
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
const splitTableRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
const isHeading = (line: string) => /^#{1,6}\s+/.test(line);
const isUl = (line: string) => /^\s*[-*+]\s+/.test(line);
const isOl = (line: string) => /^\s*\d+\.\s+/.test(line);
const isQuote = (line: string) => /^>\s?/.test(line);
const isBlockStart = (line: string) =>
  isFence(line) ||
  isHeading(line) ||
  isUl(line) ||
  isOl(line) ||
  isQuote(line) ||
  isTableRow(line);

export function Markdown({
  text,
  refResolver,
  renderMention,
}: {
  text: string;
  refResolver?: RefResolver;
  renderMention?: RenderMention;
}) {
  const opts: InlineOptions = { refResolver, renderMention };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const alignments = splitTableRow(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? "center"
          : cell.endsWith(":")
            ? "right"
            : "left",
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headerCells.map((cell, index) => (
                  <th key={index} style={{ textAlign: alignments[index] ?? "left" }}>
                    {renderInline(cell, `th${key}-${index}`, opts)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      style={{ textAlign: alignments[cellIndex] ?? "left" }}
                    >
                      {renderInline(cell, `td${key}-${rowIndex}-${cellIndex}`, opts)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (isHeading(line)) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)!;
      const level = heading[1].length;
      const content = renderInline(heading[2], `h${key}`, opts);
      const className = "md-h";
      if (level <= 2) blocks.push(<h3 key={key++} className={className}>{content}</h3>);
      else if (level === 3) blocks.push(<h4 key={key++} className={className}>{content}</h4>);
      else blocks.push(<h5 key={key++} className={className}>{content}</h5>);
      i += 1;
      continue;
    }

    if (isQuote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(buf.join(" "), `q${key}`, opts)}
        </blockquote>,
      );
      continue;
    }

    if (isUl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isUl(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, "");
        items.push(<li key={items.length}>{renderInline(content, `li${key}-${items.length}`, opts)}</li>);
        i += 1;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items}
        </ul>,
      );
      continue;
    }

    if (isOl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isOl(lines[i])) {
        const content = lines[i].replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={items.length}>{renderInline(content, `oli${key}-${items.length}`, opts)}</li>);
        i += 1;
      }
      blocks.push(
        <ol key={key++} className="md-list">
          {items}
        </ol>,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(buf.join(" "), `p${key}`, opts)}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
