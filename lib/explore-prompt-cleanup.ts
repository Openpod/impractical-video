const AVATAR_MARKER_PATTERN = /<<<\s*avatar:[^>]*>>>/gi;
const TRAILING_SLASH_PATTERN = /\\+$/g;

function collapseDuplicateLeadLines(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    if (
      next &&
      current.length >= 12 &&
      next.length > current.length + 12 &&
      next.toLowerCase().startsWith(current.toLowerCase())
    ) {
      continue;
    }
    collapsed.push(current);
  }

  return collapsed.join("\n\n");
}

export function cleanExplorePromptText(value: string | null | undefined) {
  if (!value) return "";
  const withoutMarkers = value
    .replace(AVATAR_MARKER_PATTERN, "")
    .replace(TRAILING_SLASH_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return collapseDuplicateLeadLines(withoutMarkers);
}

export function cleanExplorePromptNullable(value: string | null | undefined) {
  const cleaned = cleanExplorePromptText(value);
  return cleaned.length ? cleaned : null;
}
