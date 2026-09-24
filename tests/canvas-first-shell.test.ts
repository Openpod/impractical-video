import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("canvas-first shell wiring", () => {
  it("keeps workflows internal while the visible composer accepts open intent", async () => {
    const canvas = await readFile(
      `${root}/app/projects/[id]/canvas-workspace.tsx`,
      "utf8",
    );
    const workbench = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );
    const route = await readFile(
      `${root}/app/api/projects/[id]/canvas/composer/route.ts`,
      "utf8",
    );

    expect(canvas).toContain("const FLOWS_ENABLED = false");
    expect(workbench).toContain("const FLOWS_ENABLED = false");
    expect(canvas).toContain("Ask for anything—create, change, combine, or finish");
    expect(route).toContain("OPEN_INTENT_ORCHESTRATION");
    expect(route).toContain("loadWorkflow: tool");
    expect(route).toContain("call load_workflow before planning");
    expect(canvas).toContain("onAbort={isSending && onAbort ? onAbort : null}");
  });

  it("keeps legacy chat and Plan out of the rendered shell and makes hidden Editor inert", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );

    expect(source).toContain("const renderLegacyChatPanel = false");
    expect(source).toContain('{workspaceView === "editor" ? (');
    expect(source).toContain("<OpencutEditorMount");
    expect(source).not.toContain('aria-hidden={workspaceView !== "editor"}');
    expect(source).not.toContain('aria-label="Plan"');
    expect(source).not.toContain("onWorkflowPick={(text)");
  });

  it("hydrates Activity from durable failed operation receipts", async () => {
    const source = await readFile(
      `${root}/app/projects/[id]/project-workbench.tsx`,
      "utf8",
    );
    const overlay = await readFile(
      `${root}/app/projects/[id]/agent-activity-overlay.tsx`,
      "utf8",
    );

    expect(source).toContain(
      "() => failedActivitiesFromOperationFiles(initialSnapshot.files)",
    );
    expect(source).toContain("<DesktopWindowChrome");
    expect(source).toContain("activity={agentActivityEvent}");
    expect(source).toContain("onOpenChange={changeAgentActivityOpen}");
    expect(overlay).toContain('id="agent-activity-surface"');
    expect(overlay).toContain("hidden={!open}");
    expect(overlay).toContain("agent-activity-attention");
  });
});
