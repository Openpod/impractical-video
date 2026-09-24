import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCompanionWorkflow,
  isWorkflowLookupError,
  readWorkflow,
} from "@/lib/workflows";

const page = readFileSync("app/companion/page.tsx", "utf8");
const flowsModal = readFileSync("components/flows-modal.tsx", "utf8");
const preload = readFileSync("desktop/preload.mjs", "utf8");
const main = readFileSync("desktop/main.mjs", "utf8");
const chrome = readFileSync("app/desktop-window-chrome.tsx", "utf8");
const appShell = readFileSync("app/app-shell.tsx", "utf8");
const route = readFileSync("app/api/projects/[id]/companion/route.ts", "utf8");
const session = readFileSync("lib/companion-session.ts", "utf8");

describe("companion UI integration", () => {
  it("uses real attachment, reference, workflow, and model request fields", () => {
    expect(page).toContain('aria-label="Add attachment or project reference"');
    expect(page).toContain("Add project item");
    expect(page).toContain("setWorkflowDialogOpen(true)");
    expect(page).toContain("references: selectedReferences.map");
    expect(page).toContain("workflowId: selectedWorkflow?.id");
    expect(page).toContain("model,");
    expect(page).not.toContain('"Default"');
  });

  it("keeps manual flow selection out of the default companion surface", () => {
    expect(page).toContain("const MANUAL_WORKFLOWS_ENABLED = false");
    expect(page).toContain("{MANUAL_WORKFLOWS_ENABLED ? (");
    expect(page).toContain('projectId ? "Ask for anything…"');
  });

  it("keeps AI chat distinct from optional terminal agents", () => {
    expect(chrome).toContain('aria-label="Open AI chat"');
    expect(chrome).toContain('title="AI chat"');
    expect(appShell).not.toContain("DesktopConnectionIndicator");
    expect(appShell).toContain("Open Codex in Terminal");
    expect(appShell).toContain("Open Claude in Terminal");
    expect(page).toContain("Codex installed · Open in Terminal");
    expect(page).toContain('connectAgent("codex")');
    expect(page).toContain("No terminal window is");
  });

  it("supplies automatic workflow routing to the companion agent", () => {
    expect(session).toContain("OPEN_INTENT_ORCHESTRATION");
    expect(session).toContain("await listWorkflowSummaries()");
    expect(session).toContain("call the video-fs load_workflow tool");
    expect(flowsModal).toContain("onOpenChange(false)");
  });

  it("explicitly approves the project MCP server in headless chat sessions", () => {
    expect(session).toContain('"--settings"');
    expect(session).toContain('enabledMcpjsonServers: ["video-fs"]');
    expect(session).toContain('"--mcp-config"');
    expect(session).toContain("COMPANION_LAUNCH_CONTRACT_VERSION = 5");
    expect(session).toContain(
      "stored.launchContractVersion ===",
    );
  });

  it("retains persisted workflow fields only for backward compatibility", () => {
    expect(page).toContain("workflowId: selectedWorkflow?.id ?? null");
    expect(page).toContain("composeSnapshotRef.current");
    expect(page).toContain("companionComposeSet");
    expect(page).toContain("companionComposeGet");
    expect(page).toContain("const workflow = MANUAL_WORKFLOWS_ENABLED");
  });

  it("rejects invalid Flow ids without starting a companion request", async () => {
    await expect(readWorkflow("../not-a-flow")).rejects.toThrow(
      "Invalid workflow id.",
    );
    await expect(readWorkflow("missing-flow-id")).rejects.toThrow(
      "Workflow not found: missing-flow-id",
    );
    expect(isWorkflowLookupError(new Error("Invalid workflow id."))).toBe(true);
    expect(route).toContain("isWorkflowLookupError(error) ? 400 : 502");
  });

  it("appends the complete raw workflow Markdown exactly once", async () => {
    const workflow = await readWorkflow("product-hero-ad");
    const rendered = formatCompanionWorkflow(workflow);
    expect(rendered.split(workflow.content)).toHaveLength(2);
    expect(rendered.endsWith(workflow.content)).toBe(true);
    expect(session).toContain("workflow ? `\\n${formatCompanionWorkflow(workflow)}` : \"\"");
    expect(session.match(/formatCompanionWorkflow\(workflow\)/g)).toHaveLength(1);
    expect(session).toContain("await readWorkflow(input.workflowId)");
  });

  it("has no pin IPC or parent/always-on-top companion path", () => {
    expect(page).toContain("companionTitleSet");
    expect(main).toContain("page-title-updated");
    expect(main).toContain("Chat —");
    expect(page).not.toContain("companionPin");
    expect(preload).not.toContain("companion-pin");
    expect(main).not.toContain('"video-fs:companion-pin"');
    expect(main).not.toContain("setParentWindow");
    expect(main).not.toContain("setAlwaysOnTop");
    expect(main).not.toMatch(/parent:\s*mainWindow/);
  });

  it("persists the complete compose state outside project storage", () => {
    expect(page).toContain("companionComposeGet");
    expect(page).toContain("companionComposeSet");
    expect(page).toContain("companionAttachmentStore");
    expect(page).toContain("companionAttachmentRemove");
    expect(page).toContain("loadEpochRef");
    expect(preload).toContain("video-fs:companion-compose-get");
    expect(main).toContain("companion-compose");
    expect(main).not.toContain("companionModelGet");
  });

  it("preserves attachment ordering independently of hidden workflow state", () => {
    expect(page).toContain("setLocalAttachments((current) =>");
    expect(page).not.toContain("setSelectedWorkflow(null);\n          setLocalAttachments");
    expect(page).not.toContain("setLocalAttachments([]);\n                  const prefix");
  });
});
