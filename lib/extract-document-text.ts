/**
 * Best-effort plain-text extraction for uploaded documents so the project agent
 * can read their CONTENT (not just see a binary). Returns null when the file
 * isn't text-extractable (e.g. an image) — callers should still keep the bytes.
 */

const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rtf", "json", "jsonl", "csv", "tsv",
  "yaml", "yml", "toml", "ini", "env", "xml", "log",
  "js", "ts", "jsx", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cpp", "hpp", "cs", "php", "html", "htm", "css", "scss",
  "sass", "less", "sql", "sh", "bash", "zsh", "vue", "svelte",
]);

const NUL = String.fromCharCode(0);

function extensionOf(name: string) {
  return (name.split(".").pop() ?? "").toLowerCase();
}

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  const ext = extensionOf(filename);
  const mime = (mimeType || "").toLowerCase();

  if (mime.includes("pdf") || ext === "pdf") {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const text = (result?.text ?? "").trim();
        return text || null;
      } finally {
        await parser.destroy().catch(() => {});
      }
    } catch {
      return null;
    }
  }

  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || TEXT_EXTENSIONS.has(ext)) {
    try {
      const text = buffer.toString("utf8");
      // Crude binary guard: real text shouldn't contain NUL bytes.
      if (text.includes(NUL)) return null;
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  return null;
}
