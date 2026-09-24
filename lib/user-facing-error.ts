export function userFacingError(error: unknown, fallback = "Something went wrong.") {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  if (/content_policy_violation|content checker|flagged by a content checker/i.test(raw)) {
    return "The image provider blocked that request. Try softening the wording or image reference and run it again.";
  }
  if (/insufficient credits/i.test(raw)) return raw;
  if (/^status\s+\d+\s+—\s+\{/.test(raw)) {
    try {
      const jsonText = raw.replace(/^status\s+\d+\s+—\s+/, "");
      const parsed = JSON.parse(jsonText) as { detail?: Array<{ msg?: string }> } | { error?: string };
      const detail = "detail" in parsed ? parsed.detail?.[0]?.msg : null;
      return detail || ("error" in parsed ? parsed.error : fallback) || fallback;
    } catch {
      return fallback;
    }
  }
  return raw || fallback;
}
