import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAgentPresence } from "@/lib/agent-presence";
import {
  createAgentTurnSnapshot,
  inspectAgentContextEntities,
  readAgentContextAttachmentContext,
  readAgentContextRevision,
  readAgentContextStatus,
  readAgentTurnSnapshot,
  readCurrentAgentContext,
} from "@/lib/agent-context";
import {
  EditorTimelineError,
  executeEditorTimelineCommand,
  getEditorTimeline,
} from "@/lib/editor-timeline-commands";
import {
  executeEditorEditCommand,
  executeEditorStructureCommand,
} from "@/lib/editor-edit-commands";
import { isLocalAppMode } from "@/lib/app-mode";
import {
  generateFalAudio,
  generateFalMusic,
  generateFalSpeech,
  generateFalVoiceDesign,
} from "@/lib/media";
import {
  withJsonFrontmatter,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  AgentInteractionError,
  agentInteractionErrorPayload,
  createAgentInteraction,
  createAgentApprovalRequestSchema,
  createAgentInputRequestSchema,
  waitForAgentInteraction,
} from "@/lib/agent-interactions";
import { resolvedCanvasContextArtifactSchema } from "@/lib/canvas-context-identity";
import { readWorkflow } from "@/lib/workflows";
import {
  paperCheckProject,
  paperCreateScene,
  paperGenerateClip,
  paperGenerateImage,
  paperGenerateReferencePortfolio,
  paperGetProjectStatus,
  paperScaffoldKeyframe,
} from "@/lib/paper-tools";
import {
  isProjectBearerAuthorized,
  resolveBoundProjectRoot,
} from "../../../../desktop/project-binding.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const editorMutationBase = {
  actor: z
    .object({
      id: z.string().min(1),
      type: z.enum(["agent", "system", "user"]),
    })
    .strict(),
  baseEditorRevision: z.number().int().nonnegative(),
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  origin: z.enum(["api", "claude", "codex", "mcp"]),
  projectId: z.string().min(1),
  sceneId: z.string().min(1).optional(),
};
const editorTarget = z
  .object({
    artifact: resolvedCanvasContextArtifactSchema,
    elementId: z.string().min(1),
    trackId: z.string().min(1),
  })
  .strict();

const requestSchema = z.discriminatedUnion("tool", [
  z.object({
    arguments: z.object({
      projectId: z.string().min(1),
      workflowId: z.string().min(1),
    }),
    tool: z.literal("load_workflow"),
  }),
  z.object({
    arguments: z.object({
      body: z.string().min(1),
      index: z.number().int().positive(),
      projectId: z.string().min(1),
      referenceIds: z.array(z.string()).optional(),
      sceneId: z.string().min(1),
      title: z.string().min(1),
    }),
    tool: z.literal("create_scene"),
  }),
  z.object({
    arguments: z.object({
      aspectRatio: z.string().optional(),
      body: z.string().min(1),
      depicts: z.array(z.string()).optional(),
      keyframeId: z.string().min(1),
      projectId: z.string().min(1),
      stateAnchor: z.string().nullable().optional(),
      title: z.string().min(1),
    }),
    tool: z.literal("scaffold_keyframe"),
  }),
  z.object({
    arguments: z.object({
      aspectRatio: z.string().optional(),
      portfolioCategory: z.string().optional(),
      portfolioDisplayOnly: z.boolean().optional(),
      portfolioReferenceId: z.string().optional(),
      projectId: z.string().min(1),
      prompt: z.string().min(1),
      referenceOrKeyframeId: z.string().min(1),
      sourceIds: z.array(z.string()).optional(),
      title: z.string().min(1),
    }),
    tool: z.literal("generate_image"),
  }),
  z.object({
    arguments: z.object({
      aspectRatio: z.string().optional(),
      clipId: z.string().min(1),
      durationSeconds: z.number().optional(),
      extendsClipId: z.string().nullable().optional(),
      fromKeyframeId: z.string().nullable().optional(),
      projectId: z.string().min(1),
      prompt: z.string().min(1),
      referenceIds: z.array(z.string().min(1)).max(9).optional(),
      sceneId: z.string().min(1),
      title: z.string().min(1),
      toKeyframeId: z.string().nullable().optional(),
    }),
    tool: z.literal("generate_clip"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("check_project"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("get_project_status"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("get_agent_context"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("get_agent_context_status"),
  }),
  z.object({
    arguments: z.object({
      projectId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
    tool: z.literal("get_agent_context_revision"),
  }),
  z.object({
    arguments: z.object({
      attachmentId: z
        .string()
        .regex(/^att_[a-f0-9]{32}$/),
      projectId: z.string().min(1),
    }),
    tool: z.literal("get_agent_context_attachment"),
  }),
  z.object({
    arguments: z
      .object({
        agent: z.enum(["claude", "codex"]),
        agentSessionId: z.string().min(1),
        expectedContextRevision: z.number().int().nonnegative().optional(),
        projectId: z.string().min(1),
        turnId: z.string().min(1).nullable().optional(),
        windowId: z.string().min(1),
      })
      .strict(),
    tool: z.literal("create_agent_turn_snapshot"),
  }),
  z.object({
    arguments: z.object({
      projectId: z.string().min(1),
      snapshotId: z.string().regex(/^turn_[A-Za-z0-9-]+$/),
    }),
    tool: z.literal("get_agent_turn_snapshot"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("refresh_agent_context"),
  }),
  z.object({
    arguments: z.object({
      agent: z.enum(["claude", "codex"]).optional(),
      projectId: z.string().min(1),
    }),
    tool: z.literal("agent_presence_ping"),
  }),
  z.object({
    arguments: z
      .object({
        agent: z.enum(["claude", "codex"]),
        agentSessionId: z.string().min(1),
        projectId: z.string().min(1),
        turnId: z.string().min(1).nullable().optional(),
        windowId: z.string().min(1),
      })
      .strict(),
    tool: z.literal("rebase_agent_context"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }),
    tool: z.literal("get_connection_status"),
  }),
  z.object({
    arguments: createAgentInputRequestSchema,
    tool: z.literal("agent_request_input"),
  }),
  z.object({
    arguments: createAgentApprovalRequestSchema,
    tool: z.literal("agent_request_approval"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }).strict(),
    tool: z.literal("editor_timeline_get"),
  }),
  z.object({
    arguments: z
      .object({
        ...editorMutationBase,
        artifact: resolvedCanvasContextArtifactSchema,
        durationTicks: z.number().int().positive(),
        elementId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        startTimeTicks: z.number().int().nonnegative(),
        trackId: z.string().min(1),
      })
      .strict(),
    tool: z.literal("editor_timeline_insert"),
  }),
  z.object({
    arguments: z
      .object({
        ...editorMutationBase,
        newStartTimeTicks: z.number().int().nonnegative(),
        target: editorTarget,
        targetTrackId: z.string().min(1),
      })
      .strict(),
    tool: z.literal("editor_timeline_move"),
  }),
  z.object({
    arguments: z
      .object({
        ...editorMutationBase,
        durationTicks: z.number().int().positive(),
        target: editorTarget,
        trimEndTicks: z.number().int().nonnegative(),
        trimStartTicks: z.number().int().nonnegative(),
      })
      .strict(),
    tool: z.literal("editor_timeline_trim"),
  }),
  z.object({
    arguments: z
      .object({
        ...editorMutationBase,
        rightElementId: z.string().min(1).optional(),
        splitTimeTicks: z.number().int().positive(),
        target: editorTarget,
      })
      .strict(),
    tool: z.literal("editor_timeline_split"),
  }),
  z.object({
    arguments: z
      .object({
        ...editorMutationBase,
        targets: z.array(editorTarget).min(1).max(100),
      })
      .strict(),
    tool: z.literal("editor_timeline_remove"),
  }),
  // editor_edit / editor_structure are validated by their own versioned
  // discriminated-union schemas in lib/editor-edit-commands.ts; the route
  // only needs projectId for authorization.
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }).passthrough(),
    tool: z.literal("editor_edit"),
  }),
  z.object({
    arguments: z.object({ projectId: z.string().min(1) }).passthrough(),
    tool: z.literal("editor_structure"),
  }),
  z.object({
    arguments: z
      .object({
        at: z.enum(["first", "last"]).optional(),
        clipId: z.string().min(1).optional(),
        crop: z
          .object({
            height: z.number().min(0).max(1),
            width: z.number().min(0).max(1),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
          })
          .strict()
          .optional(),
        endSeconds: z.number().positive().optional(),
        filters: z.record(z.string(), z.number().min(0).max(100)).optional(),
        mode: z.enum(["new", "version"]).optional(),
        op: z.enum(["crop_filters", "extract_frame", "trim"]),
        path: z.string().min(1),
        projectId: z.string().min(1),
        startSeconds: z.number().nonnegative().optional(),
        version: z.number().int().nonnegative().optional(),
      })
      .strict(),
    tool: z.literal("edit_media"),
  }),
  z.object({
    arguments: z
      .object({
        durationSeconds: z.number().min(5).max(120).optional(),
        kind: z.enum(["music", "sfx", "speech", "voice_design"]),
        previewText: z.string().max(500).optional(),
        projectId: z.string().min(1),
        prompt: z.string().min(1).max(4000).optional(),
        text: z.string().min(1).max(8000).optional(),
        title: z.string().min(1).max(200).optional(),
        voice: z.string().min(1).max(120).optional(),
      })
      .strict(),
    tool: z.literal("generate_audio"),
  }),
]);

function audioSlug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "audio"
  );
}

/** Downloads generated audio and writes it as a canvas audio tile, mirroring
 * the canvas composer's record shape. */
async function writeAudioTile({
  body,
  projectId,
  title,
  url,
}: {
  body: string;
  projectId: string;
  title: string;
  url: string;
}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated audio (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const audioId = `canvas_${audioSlug(title)}_${Date.now().toString(36)}`;
  const localPath = `media/uploads/${audioId}.mp3`;
  await writeWorkspaceBinaryFile(projectId, localPath, bytes);
  const recordPath = `uploads/${audioId}.md`;
  await writeWorkspaceFile(
    projectId,
    recordPath,
    withJsonFrontmatter(
      {
        canvas_composed: true,
        id: audioId,
        kind: "audio",
        local_path: localPath,
        status: "active",
        type: "upload",
      },
      `# ${title}\n\n${body}\n`,
    ),
  );
  return { artifactId: audioId, localPath, recordPath };
}

/** edit_media bridges to the app's existing canvas media endpoints over
 * loopback: same ffmpeg paths, versioning, and provenance the drawer uses. */
async function executeEditMedia(
  origin: string,
  args: {
    at?: "first" | "last";
    clipId?: string;
    crop?: { height: number; width: number; x: number; y: number };
    endSeconds?: number;
    filters?: Record<string, number>;
    mode?: "new" | "version";
    op: "crop_filters" | "extract_frame" | "trim";
    path: string;
    projectId: string;
    startSeconds?: number;
    version?: number;
  },
) {
  const post = async (endpoint: string, body: Record<string, unknown>) => {
    const response = await fetch(
      `${origin}/api/projects/${encodeURIComponent(args.projectId)}/canvas/${endpoint}`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : `Canvas ${endpoint} failed (${response.status}).`,
      );
    }
    return payload;
  };

  if (args.op === "trim") {
    if (
      typeof args.startSeconds !== "number" ||
      typeof args.endSeconds !== "number"
    ) {
      throw new Error("Trim requires startSeconds and endSeconds.");
    }
    const payload = await post("edit-clip", {
      clipId: args.clipId ?? "",
      mode: args.mode ?? "version",
      ops: {
        trim: { endSeconds: args.endSeconds, startSeconds: args.startSeconds },
      },
      path: args.path,
    });
    return {
      createdId: payload.created_id ?? payload.createdId ?? null,
      op: args.op,
      path: args.path,
      schema: "EditMediaReceipt@1",
      suggestedCheck:
        "Call check_project, then get_project_status to see the new version.",
    };
  }
  if (args.op === "crop_filters") {
    if (!args.crop && !args.filters) {
      throw new Error("crop_filters requires a crop and/or filters.");
    }
    await post("edit-image", {
      crop: args.crop ?? null,
      filters: args.filters ?? {},
      path: args.path,
    });
    return {
      createdId: null,
      op: args.op,
      path: args.path,
      schema: "EditMediaReceipt@1",
      suggestedCheck:
        "Call check_project; the edit landed as a new version on the same tile.",
    };
  }
  const payload = await post("tile-ops", {
    at: args.at ?? "last",
    op: "extract_frame",
    path: args.path,
    version: args.version,
  });
  return {
    createdId: payload.created_id ?? null,
    op: args.op,
    path: args.path,
    schema: "EditMediaReceipt@1",
    suggestedCheck:
      "Call get_project_status; the extracted frame is a new keyframe tile.",
  };
}

function isAuthorized(request: Request, projectId: string) {
  const configured = process.env.PAPER_MCP_TOKEN?.trim();
  if (!configured) return process.env.NODE_ENV !== "production";
  if (process.env.VIDEO_FS_REQUIRE_PROJECT_BINDING === "true") {
    return isProjectBearerAuthorized(
      request.headers.get("authorization"),
      configured,
      process.env.VIDEO_FS_DATA_ROOT,
      projectId,
    );
  }
  return request.headers.get("authorization") === `Bearer ${configured}`;
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid Paper MCP tool request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const projectId = parsed.data.arguments.projectId;
  if (!isAuthorized(request, projectId)) {
    return NextResponse.json(
      { error: "Paper MCP endpoint is not authorized." },
      { status: 401 },
    );
  }
  if (process.env.VIDEO_FS_REQUIRE_PROJECT_BINDING === "true") {
    try {
      await resolveBoundProjectRoot(
        process.env.VIDEO_FS_DATA_ROOT,
        projectId,
      );
    } catch {
      return NextResponse.json(
        { error: "The bound project is unavailable." },
        { status: 404 },
      );
    }
  }
  try {
    const call = parsed.data;
    switch (call.tool) {
      case "load_workflow":
        return NextResponse.json({
          workflow: await readWorkflow(call.arguments.workflowId),
        });
      case "create_scene":
        return NextResponse.json(await paperCreateScene(call.arguments));
      case "scaffold_keyframe":
        return NextResponse.json(await paperScaffoldKeyframe(call.arguments));
      case "generate_image":
        // A portfolio target routes through the app-owned portfolio flow:
        // sheet + derived display/profile shot + portfolio.md write.
        if (call.arguments.portfolioReferenceId) {
          return NextResponse.json(
            await paperGenerateReferencePortfolio({
              category: call.arguments.portfolioCategory ?? "characters",
              displayOnly: call.arguments.portfolioDisplayOnly,
              projectId: call.arguments.projectId,
              prompt: call.arguments.prompt,
              referenceId: call.arguments.portfolioReferenceId,
              sourceIds: call.arguments.sourceIds,
              title: call.arguments.title,
            }),
          );
        }
        return NextResponse.json(await paperGenerateImage(call.arguments));
      case "generate_clip":
        return NextResponse.json(await paperGenerateClip(call.arguments));
      case "check_project":
        return NextResponse.json(await paperCheckProject(call.arguments.projectId));
      case "get_project_status":
        return NextResponse.json(await paperGetProjectStatus(call.arguments.projectId));
      case "get_agent_context": {
        const context = await readCurrentAgentContext(call.arguments.projectId);
        return NextResponse.json({
          context,
          staleEntities: await inspectAgentContextEntities(context),
        });
      }
      case "get_agent_context_status":
        return NextResponse.json(
          await readAgentContextStatus(call.arguments.projectId),
        );
      case "get_agent_context_revision": {
        const context = await readAgentContextRevision(
          call.arguments.projectId,
          call.arguments.revision,
        );
        return NextResponse.json({
          context,
          staleEntities: await inspectAgentContextEntities(context),
        });
      }
      case "get_agent_context_attachment":
        return NextResponse.json({
          attachment: await readAgentContextAttachmentContext(
            call.arguments.projectId,
            call.arguments.attachmentId,
          ),
        });
      case "create_agent_turn_snapshot":
        return NextResponse.json({
          snapshot: await createAgentTurnSnapshot(
            call.arguments.projectId,
            {
              ...call.arguments,
              turnId: call.arguments.turnId ?? null,
            },
          ),
        });
      case "get_agent_turn_snapshot":
        return NextResponse.json({
          snapshot: await readAgentTurnSnapshot(
            call.arguments.projectId,
            call.arguments.snapshotId,
          ),
        });
      case "refresh_agent_context": {
        const context = await readCurrentAgentContext(call.arguments.projectId);
        return NextResponse.json({
          context,
          refreshed: true,
          staleEntities: await inspectAgentContextEntities(context, {
            verifyHashes: true,
          }),
        });
      }
      case "rebase_agent_context":
        return NextResponse.json({
          snapshot: await createAgentTurnSnapshot(
            call.arguments.projectId,
            {
              ...call.arguments,
              turnId: call.arguments.turnId ?? null,
            },
          ),
        });
      case "get_connection_status":
        return NextResponse.json({
          connected: true,
          context: await readAgentContextStatus(call.arguments.projectId),
          projectId: call.arguments.projectId,
          transport: "loopback",
        });
      case "agent_presence_ping":
        recordAgentPresence(call.arguments.agent ?? null);
        return NextResponse.json({ ok: true });
      case "agent_request_input": {
        const request = await createAgentInteraction(call.arguments);
        return NextResponse.json({
          request: await waitForAgentInteraction(
            call.arguments.projectId,
            request.id,
          ),
        });
      }
      case "agent_request_approval": {
        const request = await createAgentInteraction(call.arguments);
        return NextResponse.json({
          request: await waitForAgentInteraction(
            call.arguments.projectId,
            request.id,
          ),
        });
      }
      case "editor_timeline_get":
        return NextResponse.json(
          await getEditorTimeline(call.arguments.projectId),
        );
      case "editor_timeline_insert":
      case "editor_timeline_move":
      case "editor_timeline_trim":
      case "editor_timeline_split":
      case "editor_timeline_remove":
        return NextResponse.json(
          await executeEditorTimelineCommand({
            ...call.arguments,
            tool: call.tool,
          }),
        );
      case "editor_edit":
        return NextResponse.json(
          await executeEditorEditCommand(call.arguments),
        );
      case "editor_structure":
        return NextResponse.json(
          await executeEditorStructureCommand(call.arguments),
        );
      case "edit_media": {
        if (!isLocalAppMode(process.env)) {
          return NextResponse.json(
            { error: "edit_media is only available in the desktop app." },
            { status: 501 },
          );
        }
        const origin = new URL(request.url).origin;
        return NextResponse.json(
          await executeEditMedia(origin, call.arguments),
        );
      }
      case "generate_audio": {
        const args = call.arguments;
        if (args.kind === "voice_design") {
          if (!args.prompt) {
            return NextResponse.json(
              { error: "voice_design requires a prompt describing the voice." },
              { status: 400 },
            );
          }
          const designed = await generateFalVoiceDesign({
            prompt: args.prompt,
            text: args.previewText ?? null,
          });
          if (!designed.ok) {
            return NextResponse.json({ error: designed.error }, { status: 502 });
          }
          return NextResponse.json({
            kind: args.kind,
            schema: "GenerateAudioReceipt@1",
            suggestedCheck:
              "Pass a returned voiceId as `voice` to generate_audio kind=speech.",
            voicePreviews: designed.previews.map((preview) => ({
              url: preview.url,
              voiceId: preview.voiceId,
            })),
          });
        }
        const title = args.title?.trim();
        if (!title) {
          return NextResponse.json(
            { error: "generate_audio requires a title for the audio tile." },
            { status: 400 },
          );
        }
        let generated:
          | { error?: string; ok: boolean; url?: string | null }
          | null = null;
        let body = "";
        if (args.kind === "speech") {
          if (!args.text) {
            return NextResponse.json(
              { error: "speech requires `text` to speak." },
              { status: 400 },
            );
          }
          generated = await generateFalSpeech({
            text: args.text,
            voice: args.voice,
          });
          body = `Generated speech.\n\n> ${args.text.slice(0, 400)}`;
        } else if (args.kind === "music") {
          if (!args.prompt) {
            return NextResponse.json(
              { error: "music requires a `prompt` brief." },
              { status: 400 },
            );
          }
          generated = await generateFalMusic({
            durationSeconds: args.durationSeconds,
            prompt: args.prompt,
          });
          body = `Generated music.\n\n> ${args.prompt.slice(0, 400)}`;
        } else {
          if (!args.prompt) {
            return NextResponse.json(
              { error: "sfx requires a `prompt` describing the sound." },
              { status: 400 },
            );
          }
          generated = await generateFalAudio({ prompt: args.prompt });
          body = `Generated sound effect.\n\n> ${args.prompt.slice(0, 400)}`;
        }
        if (!generated.ok || !generated.url) {
          return NextResponse.json(
            { error: generated.error || "Audio generation failed." },
            { status: 502 },
          );
        }
        const written = await writeAudioTile({
          body,
          projectId: args.projectId,
          title,
          url: generated.url,
        });
        return NextResponse.json({
          artifactId: written.artifactId,
          kind: args.kind,
          localPath: written.localPath,
          recordPath: written.recordPath,
          schema: "GenerateAudioReceipt@1",
          suggestedCheck:
            "Call check_project; the audio tile is on the canvas.",
          title,
        });
      }
    }
  } catch (error) {
    if (error instanceof EditorTimelineError) {
      return NextResponse.json(
        {
          code: error.code,
          error: error.message,
          remediation: error.remediation,
        },
        { status: error.status },
      );
    }
    if (error instanceof AgentInteractionError) {
      const interactionError = agentInteractionErrorPayload(error);
      return NextResponse.json(interactionError.body, {
        status: interactionError.status,
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Paper MCP tool failed." },
      { status: 500 },
    );
  }
}
