/** Deterministic identity color for a reference/tile id — the same id gets
 * the same hue everywhere (mention tokens, badges, popover dots), with no
 * storage needed and full retroactivity for existing references. */
export function mentionColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 70% 52%)`;
}
