import { describe, expect, it } from "vitest";
import {
  companionModelStorageKey,
  companionProjectReferences,
  normalizeCompanionModel,
  normalizeRequestedCompanionReferences,
  resolvedCompanionModel,
} from "@/lib/companion-contract";

describe("companion contract", () => {
  it("resolves an actual supported model and never a default sentinel", () => {
    expect(resolvedCompanionModel()).toBe("sonnet");
    expect(resolvedCompanionModel("opus")).toBe("opus");
    expect(resolvedCompanionModel("Default")).toBe("sonnet");
    expect(normalizeCompanionModel("haiku")).toBe("haiku");
    expect(normalizeCompanionModel(null)).toBeNull();
  });

  it("persists model choice in a project-specific key", () => {
    expect(companionModelStorageKey("project-a")).toBe(
      "video-fs-companion-model:project-a",
    );
    expect(companionModelStorageKey("project-b")).not.toBe(
      companionModelStorageKey("project-a"),
    );
  });

  it("derives only normalized project-safe reference descriptors", () => {
    const references = companionProjectReferences([
      {
        path: "uploads/upload_a.md",
        content:
          '---\n{"id":"upload_a","kind":"image","local_path":"media/uploads/a.png","original_name":"A.png"}\n---\n# A\n',
      },
      {
        path: "../outside.md",
        content: '---\n{"id":"outside"}\n---\n',
      },
      {
        path: ".video-fs/agent-context/current.json",
        content: "{}",
      },
    ]);
    expect(references).toEqual([
      {
        id: "upload_a",
        kind: "image",
        path: "uploads/upload_a.md",
        previewPath: "media/uploads/a.png",
        title: "A.png",
      },
    ]);
  });

  it("reconstructs requested references from the server catalog", () => {
    const available = companionProjectReferences([
      {
        path: "references/ref_a.md",
        content: '---\n{"id":"ref_a","title":"Reference A"}\n---\n',
      },
    ]);
    expect(
      normalizeRequestedCompanionReferences(
        [{ id: "ref_a", path: "references/ref_a.md" }],
        available,
      ),
    ).toEqual(available);
    expect(
      normalizeRequestedCompanionReferences(
        [{ id: "ref_a", path: "references/other.md" }],
        available,
      ),
    ).toEqual([]);
  });
});
