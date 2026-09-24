import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  closeProjectTab,
  measureChromeContainment,
  openProjectTab,
  readOpenProjectTabIds,
  reconcileOpenProjectTabs,
  reorderProjectTab,
  reorderProjectTabRelative,
} from "@/app/desktop-project-tabs";
import {
  isVisibleProjectTabActivity,
  lifecycleFromAgentInteraction,
  projectTabLifecycleForDisplay,
  readProjectTabActivityMap,
  reconcileProjectTabActivityMap,
} from "@/app/project-tab-activity";

const root = process.cwd();

describe("desktop project tabs", () => {
  it("persists a stable ordered set and activates an existing tab without reordering", () => {
    expect(readOpenProjectTabIds('["alpha","beta","alpha",""]')).toEqual([
      "alpha",
      "beta",
    ]);
    expect(openProjectTab(["alpha", "beta"], "alpha")).toEqual([
      "alpha",
      "beta",
    ]);
    expect(openProjectTab(["alpha"], "beta")).toEqual(["alpha", "beta"]);
  });

  it("keeps every tab until explicitly closed, opening the current project", () => {
    // Tabs survive a transiently incomplete catalog: ids the catalog cannot
    // name yet keep their slot instead of being dropped.
    expect(
      reconcileOpenProjectTabs({
        availableProjects: [
          { id: "alpha", name: "Alpha" },
          { id: "gamma", name: "Gamma" },
        ],
        currentProject: { id: "gamma", name: "Gamma" },
        projectIds: ["alpha", "deleted"],
      }),
    ).toEqual(["alpha", "deleted", "gamma"]);
  });

  it("closes only the view and selects the nearest remaining tab", () => {
    expect(closeProjectTab(["alpha", "beta", "gamma"], "beta")).toEqual({
      nextProjectId: "gamma",
      projectIds: ["alpha", "gamma"],
    });
    expect(closeProjectTab(["alpha"], "alpha")).toEqual({
      nextProjectId: null,
      projectIds: [],
    });
  });

  it("reorders tabs by bounded position while preserving every project exactly once", () => {
    expect(reorderProjectTab(["alpha", "beta", "gamma"], "alpha", 2)).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
    expect(reorderProjectTab(["alpha", "beta", "gamma"], "gamma", -3)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(reorderProjectTab(["alpha", "beta", "gamma"], "missing", 1)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(
      reorderProjectTabRelative(
        ["alpha", "beta", "gamma"],
        "alpha",
        "beta",
        "after",
      ),
    ).toEqual(["beta", "alpha", "gamma"]);
    expect(
      reorderProjectTabRelative(
        ["alpha", "beta", "gamma"],
        "gamma",
        "beta",
        "before",
      ),
    ).toEqual(["alpha", "gamma", "beta"]);
  });

  it("handles empty, singleton, overflow, duplicate, missing, and rapid close sequences", () => {
    const many = Array.from({ length: 24 }, (_, index) => `project-${index}`);
    expect(reorderProjectTab([], "alpha", 0)).toEqual([]);
    expect(reorderProjectTab(["alpha"], "alpha", 12)).toEqual(["alpha"]);
    expect(openProjectTab(many, "project-4")).toEqual(many);
    expect(readOpenProjectTabIds(JSON.stringify([...many, ...many]))).toEqual(
      many,
    );
    expect(
      reconcileOpenProjectTabs({
        availableProjects: many
          .filter((id) => id !== "project-8")
          .map((id) => ({ id, name: id })),
        projectIds: [...many, "stale-project"],
      }),
    ).toEqual([...many, "stale-project"]);

    const afterFirst = closeProjectTab(many, "project-0");
    expect(afterFirst.nextProjectId).toBe("project-1");
    const afterLast = closeProjectTab(
      afterFirst.projectIds,
      "project-23",
    );
    expect(afterLast.nextProjectId).toBe("project-22");
    const afterActive = closeProjectTab(
      afterLast.projectIds,
      "project-12",
    );
    expect(afterActive.nextProjectId).toBe("project-13");
    expect(afterActive.projectIds).toHaveLength(21);
  });

  it("keeps route-only tab code away from project bindings and context mutation", async () => {
    const source = await readFile(
      `${root}/app/desktop-window-chrome.tsx`,
      "utf8",
    );

    expect(source).toContain('router.push(href)');
    expect(source).not.toMatch(
      /agent-context|context snapshot|setup-agent|\.claude|\.codex|project binding/i,
    );
    // The only mutation the chrome makes is creating a blank project from the
    // + tab; it never deletes or touches agent context.
    expect(source).toContain('fetch("/api/projects", {');
    expect(source).toContain("createBlankProject");
    expect(source).not.toContain('method: "DELETE"');
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key !== "ArrowLeft"');
    expect(source).toContain(
      'aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"',
    );
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("draggable");
    expect(source).toContain("onDragStart");
    expect(source).toContain("onDrop");
    expect(source).toContain("dir=\"auto\"");
    expect(source).toContain("writeOpenProjectTabs(nextIds)");
    expect(source).toContain(
      "window.videoFsDesktopEnvironment?.platform",
    );
    expect(source).toContain(
      "document.documentElement.dataset.videoFsDesktop = platform",
    );
  });

  it("keeps full international names accessible while visual labels truncate", async () => {
    const [chrome, globals] = await Promise.all([
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
    ]);

    expect(chrome).toContain("aria-label={project.name}");
    expect(chrome).toContain("title={`${project.name}");
    expect(chrome).toContain('<span dir="auto">{project.name}</span>');
    expect(globals).toMatch(
      /\.desktop-project-tab-activate span\s*\{[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?unicode-bidi:\s*plaintext/,
    );
    expect(globals).toMatch(
      /\.desktop-project-tabs\s*\{[\s\S]*?overflow-x:\s*auto/,
    );
  });
});

describe("desktop chrome containment", () => {
  it.each([
    ["desktop", 44, [44, 44, 54, 112, 210]],
    ["compact", 44, [44, 44, 44, 98, 142]],
    ["scrolled", 44, [44, 44, 44, 88, 126]],
    ["resized", 44, [44, 44, 44, 92, 138]],
    ["fullscreen", 44, [44, 44, 44, 96, 144]],
  ])(
    "measures %s layout regions below the native chrome",
    (_layout, chromeBottom, regionTops) => {
      const chromeRect = vi.fn(() => ({ bottom: chromeBottom, top: 0 }));
      const regionRects = regionTops.map((top) =>
        vi.fn(() => ({ bottom: top + 40, top })),
      );
      const result = measureChromeContainment({
        chrome: { getBoundingClientRect: chromeRect },
        regions: regionRects.map((getBoundingClientRect) => ({
          getBoundingClientRect,
        })),
      });

      expect(result.valid).toBe(true);
      expect(result.chromeBottom).toBe(44);
      expect(result.regionTops).toEqual(regionTops);
      expect(chromeRect).toHaveBeenCalled();
      regionRects.forEach((rect) => expect(rect).toHaveBeenCalled());
    },
  );

  it("rejects an ordinary surface that extends behind the title row", () => {
    expect(
      measureChromeContainment({
        chrome: {
          getBoundingClientRect: () => ({ bottom: 44, top: 0 }),
        },
        regions: [
          {
            getBoundingClientRect: () => ({ bottom: 80, top: 0 }),
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it("keeps drawer, backdrop, toolbar, workspace and Inspector structurally contained", async () => {
    const [canvas, chrome, globals, inspector, workbench] = await Promise.all([
      readFile(`${root}/app/projects/[id]/canvas-workspace.tsx`, "utf8"),
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
      readFile(`${root}/app/projects/[id]/canvas-tile-inspector.tsx`, "utf8"),
      readFile(`${root}/app/projects/[id]/project-workbench.tsx`, "utf8"),
    ]);

    expect(chrome).toContain('className={`app-desktop-window-chrome${');
    expect(globals).not.toContain(".wb-nav-shell");
    expect(workbench).not.toContain('className="workbench-nav"');
    expect(workbench).not.toContain("centerActions={");
    expect(chrome).not.toContain("desktop-titlebar-center");
    expect(workbench).toContain(
      'className="tabs view-switcher desktop-titlebar-view-switcher"',
    );
    expect(workbench.indexOf("desktop-titlebar-view-switcher")).toBeLessThan(
      workbench.indexOf('className="workbench-body'),
    );
    expect(workbench).toContain("<WorkbenchSidebar");
    expect(workbench.indexOf("<WorkbenchSidebar")).toBeLessThan(
      workbench.indexOf('className="app-main-col workbench-main-col"'),
    );
    expect(canvas).toContain('className="canvas-workspace"');
    expect(canvas).toContain("<CanvasTileInspector");
    expect(canvas.indexOf("<CanvasTileInspector")).toBeGreaterThan(
      canvas.indexOf('className="canvas-workspace"'),
    );
    expect(inspector).toContain("canvas-inspector-region");
  });

  it("declares native drag space and no-drag interactive project and Activity controls", async () => {
    const globals = await readFile(`${root}/app/globals.css`, "utf8");

    expect(globals).toMatch(
      /\.app-desktop-window-chrome[\s\S]*?-webkit-app-region:\s*drag/,
    );
    expect(globals).toMatch(
      /\.desktop-project-tab[\s\S]*?-webkit-app-region:\s*no-drag/,
    );
    expect(globals).toMatch(
      /\.agent-activity-status-button[\s\S]*?-webkit-app-region:\s*no-drag/,
    );
  });

  it("provides a non-scaling reduced-motion state for the dot indicator", async () => {
    const globals = await readFile(`${root}/app/globals.css`, "utf8");

    expect(globals).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*?agent-activity-status-button \.agent-activity-dot[\s\S]*?animation:\s*none !important[\s\S]*?animation-delay:\s*0s !important[\s\S]*?animation-duration:\s*0s !important[\s\S]*?transform:\s*none !important[\s\S]*?transition:\s*none !important/,
    );
    const reducedActiveStart = globals.indexOf(
      ".agent-activity-status-button.is-active\n    .agent-activity-dot:nth-child(1)",
    );
    expect(reducedActiveStart).toBeGreaterThan(-1);
    const reducedActiveBlock = globals.slice(
      reducedActiveStart,
      globals.indexOf("}", reducedActiveStart) + 1,
    );
    expect(reducedActiveBlock).not.toContain("background:");
  });

  it("places truthful circular activity inside each project tab", async () => {
    const [chrome, globals] = await Promise.all([
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
    ]);

    expect(chrome).not.toContain('className="desktop-titlebar-agent"');
    expect(chrome).toContain('className="desktop-project-tab-activity-slot"');
    expect(chrome.indexOf('className="desktop-project-tab-activity-slot"')).toBeGreaterThan(
      chrome.indexOf('className="desktop-project-tab-activate"'),
    );
    expect(chrome.indexOf('className="desktop-project-tab-activity-slot"')).toBeLessThan(
      chrome.indexOf('className="desktop-project-tab-close"'),
    );
    expect(globals).toMatch(
      /data-video-fs-desktop="macos"[^{}]*\.app-desktop-window-chrome\s*\{[\s\S]*?padding-left:\s*calc\([\s\S]*?var\(--desktop-traffic-light-reserve\)[\s\S]*?var\(--desktop-home-leading-gap\)/,
    );
    expect(globals).toMatch(
      /data-video-fs-desktop="macos"\]\[data-video-fs-desktop-fullscreen="true"\][\s\S]*?\.app-desktop-window-chrome\s*\{[\s\S]*?padding-left:\s*var\(--desktop-chrome-inset\)/,
    );
    expect(chrome).toContain("desktop-titlebar-nav-link");
    expect(chrome).toContain("setNavExpanded");
    expect(chrome.indexOf('className="desktop-titlebar-sidebar-toggle"')).toBeLessThan(
      chrome.indexOf('className="desktop-project-tabs"'),
    );
    // Desktop carries navigation in the title bar; no docked sidebar at all.
    expect(globals).toMatch(
      /html\[data-video-fs-desktop="macos"\] \.app-shell > \.app-sidebar\s*\{[\s\S]*?display:\s*none/,
    );
    expect(globals).toMatch(
      /\.desktop-project-tab-activity-slot\s*\{[\s\S]*?right:\s*27px/,
    );
    expect(globals).toMatch(
      /\.desktop-project-tabs\s*\{[\s\S]*?margin-left:\s*0/,
    );
    expect(globals).toMatch(
      /\.agent-activity-dot\s*\{[\s\S]*?width:\s*3px;[\s\S]*?height:\s*3px;[\s\S]*?border-radius:\s*50%/,
    );
  });

  it("keeps the indicator hover undecorated and keyboard focus neutral", async () => {
    const globals = await readFile(`${root}/app/globals.css`, "utf8");
    const hover = globals.match(
      /\.agent-activity-status-button:hover,[\s\S]*?\n\}/,
    )?.[0];
    const focus = globals.match(
      /\.agent-activity-status-button:focus-visible\s*\{[\s\S]*?\n\}/,
    )?.[0];

    expect(hover).toContain("background: transparent");
    expect(hover).toContain("box-shadow: none");
    expect(hover).toContain("transform: none");
    expect(hover).not.toMatch(/accent|animation|scale/);
    expect(focus).toContain("background: var(--surface-3)");
    expect(focus).toContain("outline: none");
    expect(focus).not.toMatch(/accent|danger|#ed1d24/);
    expect(globals).toMatch(
      /\.agent-activity-status-button\.is-active \.agent-activity-dot\s*\{[\s\S]*?animation:\s*agent-activity-dot-wave/,
    );
    const wave = globals.match(
      /@keyframes agent-activity-dot-wave\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(wave).toBeDefined();
    // The running state is gray dots with a red wave washing over the grid:
    // the crest tints to the activity red, the rest stays muted.
    expect(wave).toContain("background: var(--muted)");
    expect(wave).toContain("background: var(--project-tab-activity-dot)");
    expect(wave).not.toMatch(/currentColor|#ed1d24|var\(--accent\)/);
    expect(globals).not.toMatch(
      /\.agent-activity-status-button\.is-(?:awaiting|failed) \.agent-activity-dot\s*\{[^}]*animation:/,
    );
    expect(globals).toMatch(
      /\.agent-activity-status-button\.is-resolved \.agent-activity-dot\s*\{[\s\S]*?animation:\s*agent-activity-dot-wave 760ms ease-out 1/,
    );
  });

  it("uses neutral focus treatments for shared tabs, tool buttons, and Inspector actions", async () => {
    const globals = await readFile(`${root}/app/globals.css`, "utf8");
    const selectors = [
      ".desktop-project-tab-activate:focus-visible",
      ".agent-context-indicator:focus-visible",
      ".canvas-inspector-source-link:focus-visible",
      ".canvas-inspector-icon-action:focus-visible",
      ".storyboard-tile-action-button:focus-visible",
    ];

    for (const selector of selectors) {
      const index = globals.indexOf(selector);
      expect(index).toBeGreaterThan(-1);
      const blockEnd = globals.indexOf("}", index);
      const block = globals.slice(index, blockEnd + 1);
      expect(block).not.toMatch(
        /var\(--accent\)|#ed1d24|rgba\(237,\s*29,\s*36/,
      );
    }
    expect(globals).not.toMatch(
      /\.desktop-project-tab[^{}]*:focus-visible[\s\S]{0,220}?outline:\s*[^;]*(?:accent|#ed1d24)/,
    );
  });

  it("routes a visible project-tab activity control to the existing surface", async () => {
    const [chrome, overlay, workbench] = await Promise.all([
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(
        `${root}/app/projects/[id]/agent-activity-overlay.tsx`,
        "utf8",
      ),
      readFile(`${root}/app/projects/[id]/project-workbench.tsx`, "utf8"),
    ]);

    expect(chrome).toContain("openProjectActivity(project.id)");
    expect(chrome).toContain("OPEN_PROJECT_ACTIVITY_STORAGE_KEY");
    expect(chrome).toContain("<AgentActivityStatusButton");
    expect(overlay).toContain('controlsId = "agent-activity-surface"');
    expect(overlay).toContain('id="agent-activity-surface"');
    expect(workbench).toContain(
      "setAgentActivityOpen((current) => !current)",
    );
    expect(workbench).not.toContain("<AgentActivityStatusButton");
  });

  it("keeps project lifecycle identity isolated and durable", () => {
    const activity = readProjectTabActivityMap(
      JSON.stringify({
        alpha: { id: "run-a", kind: "progress", label: "Agent working" },
        beta: { id: "ask-b", kind: "question", label: "Question waiting" },
      }),
    );
    expect(activity.alpha?.kind).toBe("progress");
    expect(activity.beta?.kind).toBe("question");
    expect(reconcileProjectTabActivityMap(activity, ["beta"])).toEqual({
      beta: activity.beta,
    });
    expect(isVisibleProjectTabActivity(undefined)).toBe(false);
    expect(
      isVisibleProjectTabActivity({
        id: "idle",
        kind: "idle",
        label: "Agent idle",
      }),
    ).toBe(false);
    expect(isVisibleProjectTabActivity(activity.alpha)).toBe(true);
  });

  it("maps durable interaction state without leaking across projects", () => {
    const event = lifecycleFromAgentInteraction({
      at: "2026-07-27T00:00:00.000Z",
      kind: "agent.interaction.awaiting",
      projectId: "beta",
      request: {
        actor: { id: "codex", type: "agent" },
        answer: null,
        choices: [],
        createdAt: "2026-07-27T00:00:00.000Z",
        expiresAt: "2026-07-27T01:00:00.000Z",
        id: "ask-b",
        kind: "input",
        originatingCommand: "editor_timeline_move",
        projectId: "beta",
        question: "Continue?",
        resolvedAt: null,
        schema: "video-fs.agent-interaction",
        schemaVersion: 1,
        status: "awaiting",
      },
    });
    expect(event).toEqual({
      id: "interaction:ask-b",
      kind: "question",
      label: "Question waiting",
    });
  });

  it("moves Share and the truthful connection bolt into the active title bar", async () => {
    const [chrome, contextPublisher, workbench, globals] = await Promise.all([
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(
        `${root}/app/projects/[id]/agent-context-publisher.tsx`,
        "utf8",
      ),
      readFile(`${root}/app/projects/[id]/project-workbench.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
    ]);

    expect(chrome).toContain('className="desktop-titlebar-actions"');
    expect(workbench).toContain("rightActions={titleBarActions}");
    expect(workbench.match(/workbench-action-share/g)).toHaveLength(1);
    expect(workbench).toContain('aria-label="Share project"');
    expect(contextPublisher).toContain("agent-context-indicator-bolt");
    expect(contextPublisher).toContain(
      'fill={state.connected ? "currentColor" : "none"}',
    );
    expect(contextPublisher).not.toContain(
      'className="agent-context-indicator-label"',
    );
    expect(contextPublisher).toContain(
      "agentConnectionIndicatorPresentation(state.connected)",
    );
    expect(globals).toMatch(
      /\.desktop-titlebar-actions\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/,
    );
  });

  it("uses the renderer-only preview lifecycle without mutating durable activity", () => {
    const durable = {
      id: "run-a",
      kind: "progress" as const,
      label: "Agent working",
    };
    expect(projectTabLifecycleForDisplay(durable, "alpha", false)).toBe(
      durable,
    );
    expect(projectTabLifecycleForDisplay(durable, "alpha", true)).toEqual({
      id: "ui-preview:alpha",
      kind: "progress",
      label: "Agent working",
    });
    expect(durable).toEqual({
      id: "run-a",
      kind: "progress",
      label: "Agent working",
    });
  });

  it("keeps Home ink independent from project Activity and removes chrome dividers", async () => {
    const [dots, globals, workbench] = await Promise.all([
      readFile(`${root}/components/dot-field.tsx`, "utf8"),
      readFile(`${root}/app/globals.css`, "utf8"),
      readFile(`${root}/app/projects/[id]/project-workbench.tsx`, "utf8"),
    ]);
    expect(dots).toContain('getPropertyValue("--home-dot-ink")');
    // Tab dots idle gray; the wave keyframes carry the red crest.
    expect(globals).toMatch(
      /\.agent-activity-status-button\.is-project-tab \.agent-activity-dot\s*\{[\s\S]*?background:\s*var\(--muted\)/,
    );
    expect(globals).not.toMatch(
      /\.agent-activity-status-button\.is-project-tab \.agent-activity-dot\s*\{[^}]*background:\s*var\(--home-dot-ink\)/,
    );
    expect(workbench).not.toContain('className="workbench-nav"');
    expect(workbench).not.toContain("navigationAction={");
    expect(workbench).not.toContain("centerActions={");
    expect(workbench).toContain("desktop-titlebar-view-switcher");
    expect(globals).toContain("--home-dot-ink: rgb(219 219 230)");
    expect(globals).toContain("--home-dot-ink: rgb(24 24 27)");
    expect(
      globals.match(/--project-tab-activity-dot:\s*#f54048/g),
    ).toHaveLength(1);
    expect(globals).not.toMatch(/--home-dot-ink:\s*#f54048/);
    expect(globals).toContain("--desktop-chrome-bg: var(--surface)");
    expect(globals).toContain("--desktop-chrome-bg: #ffffff");
    expect(globals).toContain("background: var(--desktop-chrome-bg)");
    expect(globals).toContain("background: var(--desktop-active-tab-bg)");
    const chromeRule = globals.match(
      /html\[data-video-fs-desktop="macos"\] \.app-desktop-window-chrome\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(chromeRule).toBeDefined();
    expect(chromeRule).not.toMatch(/\bborder(?:-bottom)?:/);
    expect(chromeRule).not.toMatch(/\bbox-shadow:/);
    expect(globals).not.toMatch(
      /desktop-project-tab\.is-active[\s\S]{0,360}?filter:\s*invert/,
    );
  });

  it("returns the title-bar center to tabs and keeps local switching inset", async () => {
    const [globals, projectPage] = await Promise.all([
      readFile(`${root}/app/globals.css`, "utf8"),
      readFile(`${root}/app/projects/[id]/page.tsx`, "utf8"),
    ]);
    expect(globals).toContain("--desktop-chrome-height: 44px");
    expect(globals).toContain("--desktop-chrome-inset: 7px");
    expect(globals).toContain(
      "--desktop-workspace-inset: var(--desktop-chrome-inset)",
    );
    expect(projectPage).toContain("project-page-shell");
    expect(globals).toMatch(
      /html\[data-video-fs-desktop="macos"\]\s+\.project-page-shell\s*\{[\s\S]*?padding:\s*0/,
    );
    expect(globals).toMatch(
      /html\[data-video-fs-desktop="macos"\]\s+\.project-page-shell \.workbench-body\s*\{[\s\S]*?margin:\s*[\s\S]*?0[\s\S]*?var\(--desktop-workspace-inset\)[\s\S]*?var\(--desktop-workspace-inset\)/,
    );
    expect(globals).toMatch(
      /\.desktop-titlebar-actions\s*\{[\s\S]*?padding:\s*var\(--desktop-chrome-inset\)/,
    );
    expect(globals).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    );
    expect(globals).not.toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/,
    );
    expect(globals).toMatch(
      /@media \(max-width:\s*1100px\)[\s\S]*?grid-template-columns:\s*minmax\(180px,\s*1fr\)\s+auto/,
    );
    expect(globals).not.toContain(".workspace-local-view-switcher");
    expect(globals).toMatch(
      /\.desktop-titlebar-view-switcher\.tabs\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/,
    );
    expect(globals).toMatch(
      /\.desktop-titlebar-view-switcher \.tab:focus-visible\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--desktop-chrome-veil-strong\)/,
    );
    expect(globals).not.toMatch(
      /\.workbench-body\s+\.canvas-control-panel\s*\{[\s\S]*?top:\s*52px/,
    );
    expect(globals).not.toMatch(
      /\.workbench-body[\s\S]*?\.opencut-scope[\s\S]*?\[data-host-corner-tabs\]\s*\{[\s\S]*?padding-top:\s*38px/,
    );
    expect(globals).toMatch(
      /\.app-shell\.workbench-shell\s*\{[\s\S]*?height:\s*100%/,
    );
    expect(globals).toMatch(
      /\.workbench-sidebar\s*\{[\s\S]*?width:\s*248px[\s\S]*?border-right:\s*0[\s\S]*?transition:/,
    );
    expect(globals).toMatch(
      /\.app-shell\.workbench-shell\.is-sidebar-hidden \.workbench-sidebar\s*\{[\s\S]*?width:\s*0[\s\S]*?opacity:\s*0[\s\S]*?pointer-events:\s*none/,
    );
    expect(globals).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*?\.workbench-sidebar\s*\{[\s\S]*?transition:\s*none/,
    );
  });

  it("uses one project-scoped lifecycle stream for up to twenty-four open tabs", async () => {
    const [chrome, route] = await Promise.all([
      readFile(`${root}/app/desktop-window-chrome.tsx`, "utf8"),
      readFile(`${root}/app/api/projects/tab-activity/route.ts`, "utf8"),
    ]);

    expect(chrome).toContain(
      "new EventSource(`/api/projects/tab-activity?${query}`)",
    );
    expect(chrome).toContain(".slice(0, 24)");
    expect(route).toContain("const MAX_OPEN_PROJECTS = 24");
    expect(route).toContain("projectSet.has(event.projectId)");
    expect(route).not.toMatch(/provider|model|generate/i);
  });
});
