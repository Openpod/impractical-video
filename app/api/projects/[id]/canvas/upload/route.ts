import { NextResponse } from "next/server";
import { ensureCurrentAppUser } from "@/lib/app-users";
import {
  getProjectSnapshot,
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

// Persists canvas uploads as first-class workspace artifacts: bytes under
// media/uploads/, plus an uploads/<id>.md source doc so the canvas grid, the
// composer agent, and the regenerate flow can all address them by path/id.

type Params = {
  params: Promise<{ id: string }>;
};

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 42) || "upload"
  );
}

function extensionFor(file: File) {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const subtype = file.type.split("/")[1];
  return subtype || "bin";
}

function kindFor(file: File): "audio" | "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return null;
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await ensureCurrentAppUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to upload media." }, { status: 401 });
  }
  await getProjectSnapshot(id, user.userId);

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (!files.length) {
    return NextResponse.json({ error: "No files supplied." }, { status: 400 });
  }

  const uploaded: Array<{ id: string; kind: "audio" | "image" | "video"; path: string }> = [];
  for (const [index, file] of files.entries()) {
    const kind = kindFor(file);
    if (!kind) continue;
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `"${file.name}" is too large (max 200MB).` },
        { status: 400 },
      );
    }
    const uploadId = `upload_${slug(file.name)}_${Date.now().toString(36)}${index ? `_${index}` : ""}`;
    const mediaPath = `media/uploads/${uploadId}.${extensionFor(file)}`;
    await writeWorkspaceBinaryFile(id, mediaPath, Buffer.from(await file.arrayBuffer()));
    await writeWorkspaceFile(
      id,
      `uploads/${uploadId}.md`,
      withJsonFrontmatter(
        {
          content_type: file.type,
          id: uploadId,
          kind,
          local_path: mediaPath,
          original_name: file.name,
          status: "active",
          type: "upload",
        },
        `# ${file.name}\n\nUser-uploaded ${kind} added from the canvas.\n`,
      ),
    );
    uploaded.push({ id: uploadId, kind, path: `uploads/${uploadId}.md` });
  }

  if (!uploaded.length) {
    return NextResponse.json(
      { error: "Only image, video, and audio uploads are supported." },
      { status: 400 },
    );
  }

  const snapshot = await getProjectSnapshot(id, user.userId);
  return NextResponse.json({ snapshot, uploaded });
}
