"use client";

// Host mount (video-fs-agent addition — NOT upstream code). Renders the
// opencut-classic editor in-process, chrome-free, for one host project:
//  - maps the host project id to a stable OpenCut project (created once,
//    remembered in localStorage) so EditorProvider never hits its
//    project-not-found redirect;
//  - composes the same panel layout as the stock editor page minus the
//    OpenCut header/marketing chrome;
//  - everything renders inside .opencut-scope so the vendored theme tokens
//    stay contained.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@opencut/components/ui/resizable";
import { AssetsPanel } from "@opencut/components/editor/panels/assets";
import { PropertiesPanel } from "@opencut/components/editor/panels/properties";
import { Timeline } from "@opencut/timeline/components";
import { PreviewPanel } from "@opencut/preview/components";
import { EditorProvider } from "@opencut/components/providers/editor-provider";
import { TooltipProvider } from "@opencut/components/ui/tooltip";
import { MigrationDialog } from "@opencut/project/components/migration-dialog";
import { usePanelStore } from "@opencut/editor/panel-store";
import { usePasteMedia } from "@opencut/media/use-paste-media";
import { useEditor } from "@opencut/editor/use-editor";
import { EditorCore } from "@opencut/core";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@opencut/preview/overlays";
import { usePreviewStore } from "@opencut/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@opencut/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@opencut/timeline/bookmarks/index";
import { processMediaAssets } from "@opencut/media/processing";
import type { MediaAsset } from "@opencut/media/types";
import type { TProject } from "@opencut/project/types";
import { storageService } from "@opencut/services/storage/service";
import { DEFAULT_EXPORT_OPTIONS } from "@opencut/export/defaults";
import {
	getExportFileExtension,
	getExportMimeType,
} from "@opencut/export";
import { toast } from "sonner";
import {
	AlertCircle,
	ArrowLeft,
	Check,
	Download,
	Link2,
	Loader2,
	Plus,
} from "lucide-react";
import type {
	AgentContextArtifact,
	EditorAgentContext,
} from "@/app/projects/[id]/agent-context-publisher";
import {
	editorAgentContextSnapshot,
	selectedElementsForFocusedPlacement,
} from "./agent-context-publisher";
import { useAssetsPanelStore } from "@opencut/components/editor/panels/assets/assets-panel-store";
import type { ElementRef, TimelineElement, TimelineTrack } from "@opencut/timeline";
import {
	artifactFocusIdentityMatches,
	dispatchEditorDocumentRevision,
	removedPlacementPresentation,
	resolveArtifactFocusTarget,
	subscribeToRemovedPlacement,
	type ArtifactFocusIdentity,
	type ArtifactFocusRequest,
	type ArtifactFocusResult,
} from "./artifact-focus-contract";

export type HostEditorMediaAsset = {
	artifact: {
		artifactId: string;
		contentHash: string | null;
		entityRevision: number | null;
		sourcePath: string;
		versionHash: string | null;
		versionId: string | null;
		versionIndex: number | null;
	};
	id: string;
	kind: "audio" | "image" | "video";
	sourceKey?: string;
	src: string;
	title: string;
};

export type HostEditorExportStatus = {
	available: boolean;
	error: string | null;
	isExporting: boolean;
	progress: number;
};

const EXPORT_PROGRESS_TOAST_ID = "host-editor-export-progress";

function clampExportProgress(progress: number) {
	if (!Number.isFinite(progress)) return 0;
	return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

function showExportProgressToast({
	progress,
	projectName,
}: {
	progress: number;
	projectName: string;
}) {
	const rawPercent = clampExportProgress(progress);
	const percent = Math.min(rawPercent, 99);
	toast.custom(
		(id) => (
			<div className="app-export-toast" data-export-toast-id={id}>
				<div className="app-export-toast-head">
					<span className="app-export-toast-loader" aria-hidden="true">
						<Loader2 size={16} />
					</span>
					<div className="app-export-toast-copy">
						<strong>{rawPercent >= 100 ? "Finalizing MP4" : "Exporting MP4"}</strong>
						<span>{projectName}</span>
					</div>
					<span className="app-export-toast-percent">{percent}%</span>
				</div>
				<div
					className="app-export-toast-progress"
					role="progressbar"
					aria-label="Export progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
				>
					<span
						className="app-export-toast-progress-fill"
						style={{ width: `${percent}%` }}
					/>
				</div>
			</div>
		),
		{
			closeButton: false,
			duration: Infinity,
			id: EXPORT_PROGRESS_TOAST_ID,
			unstyled: true,
		},
	);
}

function showExportReadyToast({
	filename,
	projectName,
	url,
}: {
	filename: string;
	projectName: string;
	url: string;
}) {
	toast.custom(
		(id) => (
			<div className="app-export-toast is-ready" data-export-toast-id={id}>
				<div className="app-export-toast-head">
					<span className="app-export-toast-state-icon" aria-hidden="true">
						<Check size={16} />
					</span>
					<div className="app-export-toast-copy">
						<strong>MP4 ready</strong>
						<span>{projectName}</span>
					</div>
				</div>
				<div className="app-export-toast-actions">
					<button
						className="app-export-toast-button"
						type="button"
						onClick={() => triggerDownloadUrl({ filename, url })}
					>
						<Download size={14} aria-hidden="true" />
						Download MP4
					</button>
				</div>
			</div>
		),
		{
			duration: 12000,
			id: EXPORT_PROGRESS_TOAST_ID,
			unstyled: true,
		},
	);
}

function showExportFailedToast({ message }: { message: string }) {
	toast.custom(
		(id) => (
			<div className="app-export-toast is-error" data-export-toast-id={id}>
				<div className="app-export-toast-head">
					<span className="app-export-toast-state-icon" aria-hidden="true">
						<AlertCircle size={16} />
					</span>
					<div className="app-export-toast-copy">
						<strong>Export failed</strong>
						<span>{message}</span>
					</div>
				</div>
			</div>
		),
		{
			duration: 7000,
			id: EXPORT_PROGRESS_TOAST_ID,
			unstyled: true,
		},
	);
}

function triggerDownloadUrl({
	filename,
	url,
}: {
	filename: string;
	url: string;
}) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

function exportStatusesEqual(
	a: HostEditorExportStatus | null,
	b: HostEditorExportStatus,
) {
	return (
		a?.available === b.available &&
		a.error === b.error &&
		a.isExporting === b.isExporting &&
		a.progress === b.progress
	);
}

const HOST_PROJECT_MAP_KEY = "host-project-map";

type HostMediaMapEntry = {
	artifact?: {
		artifactId: string;
		contentHash: string | null;
		entityRevision: number | null;
		sourcePath: string;
		versionHash: string;
		versionId: string | null;
		versionIndex: number | null;
	};
	durationSeconds?: number | null;
	kind?: string;
	mediaId: string;
	name: string;
	sourceKey?: string;
};

type HostMediaMap = Record<string, HostMediaMapEntry>;

function readProjectMap(): Record<string, string> {
	try {
		const raw = window.localStorage.getItem(HOST_PROJECT_MAP_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function readHostMediaMap(mediaMapKey: string): HostMediaMap {
	try {
		const raw = window.localStorage.getItem(mediaMapKey);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? (parsed as HostMediaMap) : {};
	} catch {
		return {};
	}
}

function writeHostMediaMap(mediaMapKey: string, map: HostMediaMap) {
	window.localStorage.setItem(mediaMapKey, JSON.stringify(map));
}

function elementArtifactIdentity(
	element: TimelineElement | Record<string, unknown>,
): ArtifactFocusIdentity | null {
	const raw = (element as { videoFsArtifact?: unknown }).videoFsArtifact;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const version =
		value.version && typeof value.version === "object"
			? (value.version as Record<string, unknown>)
			: null;
	if (
		typeof value.artifactId !== "string" ||
		typeof value.contentHash !== "string" ||
		typeof value.entityRevision !== "number" ||
		typeof value.path !== "string"
	) {
		return null;
	}
	const versionHash =
		typeof version?.sha256 === "string"
			? version.sha256
			: value.contentHash;
	return {
		artifactId: value.artifactId,
		contentHash: value.contentHash,
		entityRevision: value.entityRevision,
		sourcePath: value.path,
		versionHash,
		versionId:
			typeof version?.versionId === "string" ? version.versionId : null,
		versionIndex:
			typeof version?.index === "number" ? version.index : null,
	};
}

function mappedArtifactIdentity(
	entry: HostMediaMapEntry | undefined,
): ArtifactFocusIdentity | null {
	const artifact = entry?.artifact;
	if (
		!artifact ||
		!artifact.contentHash ||
		artifact.entityRevision === null
	) {
		return null;
	}
	return {
		...artifact,
		contentHash: artifact.contentHash,
		entityRevision: artifact.entityRevision,
	};
}

type HostTimelinePlacement = {
	element: TimelineElement;
	elementId: string;
	sceneId: string;
	trackId: string;
	trackLabel: string;
};

function timelinePlacementsForArtifact({
	identity,
	map,
	project,
}: {
	identity: ArtifactFocusIdentity;
	map: HostMediaMap;
	project: TProject | null;
}) {
	if (!project) return [];
	const matchingMediaIds = new Set(
		Object.values(map)
			.filter((entry) => {
				const mapped = mappedArtifactIdentity(entry);
				return mapped
					? artifactFocusIdentityMatches(mapped, identity)
					: false;
			})
			.map((entry) => entry.mediaId),
	);
	const placements: HostTimelinePlacement[] = [];
	for (const scene of project.scenes) {
		const tracks = [
			scene.tracks.main,
			...scene.tracks.overlay,
			...scene.tracks.audio,
		] as TimelineTrack[];
		for (const track of tracks) {
			for (const element of track.elements) {
				const embedded = elementArtifactIdentity(element);
				const exactEmbedded =
					embedded &&
					artifactFocusIdentityMatches(embedded, identity);
				if (
					!exactEmbedded &&
					!("mediaId" in element) &&
					!matchingMediaIds.size
				) {
					continue;
				}
				const mediaId =
					"mediaId" in element && typeof element.mediaId === "string"
						? element.mediaId
						: null;
				if (!exactEmbedded && (!mediaId || !matchingMediaIds.has(mediaId))) {
					continue;
				}
				placements.push({
					element,
					elementId: element.id,
					sceneId: scene.id,
					trackId: track.id,
					trackLabel:
						typeof track.name === "string" && track.name.trim()
							? track.name.trim()
							: track.id,
				});
			}
		}
	}
	return placements;
}

function hostMediaSourceKey(asset: HostEditorMediaAsset) {
	return asset.sourceKey?.trim() || asset.src.trim() || asset.id;
}

function preferHostAsset(
	current: HostEditorMediaAsset,
	next: HostEditorMediaAsset,
) {
	const currentIsComposerPlaceholder = current.id.startsWith("compose_");
	const nextIsComposerPlaceholder = next.id.startsWith("compose_");
	if (currentIsComposerPlaceholder && !nextIsComposerPlaceholder) return next;
	return current;
}

function groupHostMediaAssets(mediaAssets: HostEditorMediaAsset[]) {
	const bySourceKey = new Map<
		string,
		{ aliases: Set<string>; asset: HostEditorMediaAsset }
	>();
	for (const asset of mediaAssets) {
		const sourceKey = hostMediaSourceKey(asset);
		const existing = bySourceKey.get(sourceKey);
		if (!existing) {
			bySourceKey.set(sourceKey, {
				aliases: new Set([asset.id]),
				asset,
			});
			continue;
		}
		existing.aliases.add(asset.id);
		existing.asset = preferHostAsset(existing.asset, asset);
	}
	return bySourceKey;
}

function findMappedHostMedia({
	aliases,
	map,
	sourceKey,
}: {
	aliases: Set<string>;
	map: HostMediaMap;
	sourceKey: string;
}) {
	for (const alias of aliases) {
		const mapped = map[alias];
		if (!mapped) continue;
		if (!mapped.sourceKey || mapped.sourceKey === sourceKey) return mapped;
	}
	for (const mapped of Object.values(map)) {
		if (mapped.sourceKey === sourceKey) return mapped;
	}
	return null;
}

function assignHostMediaAliases({
	aliases,
	entry,
	map,
	sourceKey,
}: {
	aliases: Set<string>;
	entry: HostMediaMapEntry;
	map: HostMediaMap;
	sourceKey: string;
}) {
	for (const alias of aliases) {
		map[alias] = { ...entry, sourceKey };
	}
}

function hostMediaCandidateSignature(asset: MediaAsset) {
	const duration =
		typeof asset.duration === "number" ? Math.round(asset.duration * 1000) : "";
	return [
		asset.type,
		asset.file.size,
		asset.width ?? "",
		asset.height ?? "",
		duration,
	].join("\u0000");
}

async function hostMediaContentHash(asset: MediaAsset) {
	const digest = await crypto.subtle.digest("SHA-256", await asset.file.arrayBuffer());
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function findExactDuplicateHostMediaGroups({
	assets,
	preferredMediaIds,
}: {
	assets: MediaAsset[];
	preferredMediaIds: Set<string>;
}) {
	if (!crypto.subtle) return [];
	const candidates = new Map<string, MediaAsset[]>();
	for (const asset of assets) {
		const signature = hostMediaCandidateSignature(asset);
		const group = candidates.get(signature) ?? [];
		group.push(asset);
		candidates.set(signature, group);
	}

	const exactGroups: MediaAsset[][] = [];
	for (const group of candidates.values()) {
		if (group.length < 2) continue;
		if (!group.some((asset) => preferredMediaIds.has(asset.id))) continue;
		const byHash = new Map<string, MediaAsset[]>();
		for (const asset of group) {
			try {
				const hash = await hostMediaContentHash(asset);
				const exact = byHash.get(hash) ?? [];
				exact.push(asset);
				byHash.set(hash, exact);
			} catch {
				// Hashing failure should not turn a fuzzy match into a deletion.
			}
		}
		for (const exact of byHash.values()) {
			if (exact.length > 1) exactGroups.push(exact);
		}
	}
	return exactGroups;
}

function rewriteProjectMediaIds({
	project,
	replacements,
}: {
	project: TProject;
	replacements: Map<string, string>;
}) {
	let changed = false;
	const rewriteTrack = <T extends { elements: unknown[] }>(track: T): T => {
		let trackChanged = false;
		const elements = track.elements.map((element) => {
			if (!element || typeof element !== "object") return element;
			const mediaId = (element as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== "string") return element;
			const replacement = replacements.get(mediaId);
			if (!replacement || replacement === mediaId) return element;
			trackChanged = true;
			changed = true;
			return { ...(element as object), mediaId: replacement };
		}) as T["elements"];
		return trackChanged ? ({ ...track, elements } as T) : track;
	};

	const scenes = project.scenes.map((scene) => {
		const overlay = scene.tracks.overlay.map((track) => rewriteTrack(track));
		const main = rewriteTrack(scene.tracks.main);
		const audio = scene.tracks.audio.map((track) => rewriteTrack(track));
		const sceneChanged =
			overlay.some((track, index) => track !== scene.tracks.overlay[index]) ||
			main !== scene.tracks.main ||
			audio.some((track, index) => track !== scene.tracks.audio[index]);
		if (!sceneChanged) return scene;
		return {
			...scene,
			tracks: { ...scene.tracks, audio, main, overlay },
			updatedAt: new Date(),
		};
	});

	if (!changed) return { changed: false, project };
	return {
		changed: true,
		project: {
			...project,
			metadata: { ...project.metadata, updatedAt: new Date() },
			scenes,
		},
	};
}

async function reconcileDuplicateHostMedia({
	editor,
	hostAssets,
	map,
	projectId,
}: {
	editor: EditorCore;
	hostAssets: HostEditorMediaAsset[];
	map: HostMediaMap;
	projectId: string;
}) {
	const sourceKeys = new Set(hostAssets.map((asset) => hostMediaSourceKey(asset)));
	const hostAliases = new Set(hostAssets.map((asset) => asset.id));
	const preferredMediaIds = new Set<string>();
	for (const [alias, entry] of Object.entries(map)) {
		if (
			hostAliases.has(alias) ||
			(entry.sourceKey && sourceKeys.has(entry.sourceKey))
		) {
			preferredMediaIds.add(entry.mediaId);
		}
	}
	if (!preferredMediaIds.size) return false;

	const assets = editor.media.getAssets();
	const duplicateGroups = await findExactDuplicateHostMediaGroups({
		assets,
		preferredMediaIds,
	});

	const replacements = new Map<string, string>();
	const removeIds = new Set<string>();
	for (const group of duplicateGroups) {
		const canonical =
			group.find((asset) => preferredMediaIds.has(asset.id)) ?? group[0];
		if (!canonical) continue;
		for (const asset of group) {
			if (asset.id === canonical.id) continue;
			replacements.set(asset.id, canonical.id);
			removeIds.add(asset.id);
		}
	}
	if (!removeIds.size) return false;

	for (const entry of Object.values(map)) {
		const replacement = replacements.get(entry.mediaId);
		if (replacement) entry.mediaId = replacement;
	}

	const activeProject = editor.project.getActiveOrNull();
	if (activeProject) {
		const rewritten = rewriteProjectMediaIds({
			project: activeProject,
			replacements,
		});
		if (rewritten.changed) {
			editor.scenes.setScenes({
				activeSceneId: rewritten.project.currentSceneId,
				scenes: rewritten.project.scenes,
			});
			editor.project.setActiveProject({ project: rewritten.project });
			await storageService.saveProject({ project: rewritten.project });
		}
	}

	const nextAssets = assets.filter((asset) => !removeIds.has(asset.id));
	for (const asset of assets) {
		if (!removeIds.has(asset.id)) continue;
		if (asset.url) URL.revokeObjectURL(asset.url);
		if (asset.thumbnailUrl) URL.revokeObjectURL(asset.thumbnailUrl);
	}
	editor.media.setAssets({ assets: nextAssets });
	await Promise.all(
		[...removeIds].map((id) => storageService.deleteMediaAsset({ id, projectId })),
	);
	return true;
}

/** Wire docs are raw JSON — revive the Date fields storage expects. The
 * result is handed straight to project storage, which owns validation. */
function hydrateWireProject(raw: Record<string, any>): any {
	return {
		...raw,
		metadata: {
			...raw.metadata,
			createdAt: new Date(raw.metadata?.createdAt ?? Date.now()),
			updatedAt: new Date(raw.metadata?.updatedAt ?? Date.now()),
		},
		scenes: (raw.scenes ?? []).map((scene: Record<string, unknown>) => ({
			...scene,
			createdAt: new Date((scene.createdAt as string) ?? Date.now()),
			updatedAt: new Date((scene.updatedAt as string) ?? Date.now()),
		})),
	};
}

/** Resolve (or create once) the OpenCut project backing a host project. */
function useOpencutProjectId(hostProjectId: string, hostProjectName: string) {
	const [opencutId, setOpencutId] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const map = readProjectMap();
			const editor = EditorCore.getInstance();
			let targetId =
				typeof map[hostProjectId] === "string" ? map[hostProjectId] : null;
			if (targetId) {
				try {
					await editor.project.loadProject({ id: targetId });
				} catch {
					targetId = null;
				}
			}
			if (!targetId) {
				// A server edit document may already exist (agent edits, or a
				// session from another browser profile). Adopt its project
				// instead of minting a fresh empty one — the empty project's
				// first push used to clobber every agent revision.
				try {
					const response = await fetch(
						`/api/projects/${hostProjectId}/editor-doc`,
					);
					const doc = response.ok ? await response.json() : null;
					const remoteId =
						typeof doc?.project?.metadata?.id === "string"
							? doc.project.metadata.id
							: null;
					if (remoteId && Array.isArray(doc.project.scenes)) {
						await storageService.saveProject({
							project: hydrateWireProject(doc.project),
						});
						await editor.project.loadProject({ id: remoteId });
						// Seed the media map from the server copy so hydration can
						// remap element media ids minted by the other session.
						const mediaMapKey = `host-media-map-${remoteId}`;
						if (
							doc.mediaMap &&
							typeof doc.mediaMap === "object" &&
							!window.localStorage.getItem(mediaMapKey)
						) {
							window.localStorage.setItem(
								mediaMapKey,
								JSON.stringify(doc.mediaMap),
							);
						}
						targetId = remoteId;
						const next = readProjectMap();
						next[hostProjectId] = remoteId;
						window.localStorage.setItem(
							HOST_PROJECT_MAP_KEY,
							JSON.stringify(next),
						);
					}
				} catch {
					/* fall through to a fresh local project */
				}
			}
			if (!targetId) {
				targetId = await editor.project.createNewProject({
					name: hostProjectName || "Project edit",
				});
				const next = readProjectMap();
				next[hostProjectId] = targetId;
				window.localStorage.setItem(HOST_PROJECT_MAP_KEY, JSON.stringify(next));
			}
			if (!cancelled) setOpencutId(targetId);
		})();
		return () => {
			cancelled = true;
		};
	}, [hostProjectId, hostProjectName]);
	return opencutId;
}

/** Auto-populate the editor's media bin with the host's generated content and
 * mirror the edit document to the server so the agent can read/write it. */
function useHostBridge(
	hostProjectId: string,
	opencutId: string | null,
	mediaAssets: HostEditorMediaAsset[],
	onDocumentRevisionChange?: (revision: number) => void,
) {
	// Serialized hydration queue: an asset list that changes while a pass is
	// still running must trigger another pass afterwards (an early-return
	// guard here silently dropped every mid-flight update).
	const hydrationQueueRef = useRef<Promise<void>>(Promise.resolve());
	const lastPushedRef = useRef<string>("");
	const lastAppliedRevisionRef = useRef(0);
	/** Revision of the last server doc this client synced against — sent as
	 * baseRevision on pushes so a push can never clobber an unseen agent edit. */
	const lastKnownRevisionRef = useRef<number | null>(null);
	const mediaMapKey = opencutId ? `host-media-map-${opencutId}` : "";

	// Media hydration: every host asset lands in the media bin exactly once.
	useEffect(() => {
		if (!opencutId || !mediaAssets.length) return;
		let cancelled = false;
		hydrationQueueRef.current = hydrationQueueRef.current.then(async () => {
			if (cancelled) return;
			const editor = EditorCore.getInstance();
			const activeProject = editor.project.getActiveOrNull();
			if (
				activeProject?.metadata.id !== opencutId ||
				editor.project.getIsLoading() ||
				editor.media.isLoadingMedia()
			) {
				return;
			}
			const map = readHostMediaMap(mediaMapKey);
			const known = new Set(editor.media.getAssets().map((asset) => asset.id));
			const groupedAssets = groupHostMediaAssets(mediaAssets);
			let mapChanged = false;
			for (const [sourceKey, { aliases, asset }] of groupedAssets) {
				if (cancelled) return;
				const mapped = findMappedHostMedia({ aliases, map, sourceKey });
				// Agent inserts may pre-seed the map server-side with a
				// placeholder id; once the real asset is minted below, the
				// placeholder is adopted by remapping timeline elements.
				const seededMediaId =
					mapped && !known.has(mapped.mediaId) ? mapped.mediaId : null;
				if (mapped && known.has(mapped.mediaId)) {
					if (
						asset.artifact.contentHash &&
						asset.artifact.versionHash &&
						asset.artifact.entityRevision !== null
					) {
						mapped.artifact = {
							artifactId: asset.artifact.artifactId,
							contentHash: asset.artifact.contentHash,
							entityRevision: asset.artifact.entityRevision,
							sourcePath: asset.artifact.sourcePath,
							versionHash: asset.artifact.versionHash,
							versionId: asset.artifact.versionId,
							versionIndex: asset.artifact.versionIndex,
						};
					}
					assignHostMediaAliases({ aliases, entry: mapped, map, sourceKey });
					mapChanged = true;
					continue;
				}
				try {
					const response = await fetch(asset.src);
					if (!response.ok) continue;
					const blob = await response.blob();
					const extension =
						asset.kind === "video" ? "mp4" : asset.kind === "audio" ? "mp3" : "png";
					const fallbackType =
						asset.kind === "video"
							? "video/mp4"
							: asset.kind === "audio"
								? "audio/mpeg"
								: "image/png";
					const file = new File([blob], `${asset.title}.${extension}`, {
						type: blob.type || fallbackType,
					});
					const [processed] = await processMediaAssets({ files: [file] });
					if (!processed) continue;
					const added = await editor.media.addMediaAsset({
						projectId: opencutId,
						asset: processed,
					});
					if (added) {
						const mediaHash = await hostMediaContentHash(added).catch(
							() => null,
						);
						const entry: HostMediaMapEntry = {
							artifact:
								mediaHash || asset.artifact.versionHash
									? {
											artifactId: asset.artifact.artifactId,
											contentHash:
												asset.artifact.contentHash ??
												mediaHash ??
												asset.artifact.versionHash!,
											entityRevision:
												asset.artifact.entityRevision ?? 0,
											sourcePath: asset.artifact.sourcePath,
											versionHash:
												mediaHash ??
												asset.artifact.versionHash!,
											versionId: asset.artifact.versionId,
											versionIndex: asset.artifact.versionIndex,
										}
									: undefined,
							durationSeconds: added.duration ?? null,
							kind: asset.kind,
							mediaId: added.id,
							name: asset.title,
							sourceKey,
						};
						assignHostMediaAliases({ aliases, entry, map, sourceKey });
						mapChanged = true;
						known.add(added.id);
						writeHostMediaMap(mediaMapKey, map);
						const replacements = new Map<string, string>();
						if (seededMediaId && seededMediaId !== added.id) {
							replacements.set(seededMediaId, added.id);
						}
						// Elements carry their artifact identity; any element for
						// THIS artifact whose media id is unknown here (seeded
						// placeholder, or an id minted by another browser profile
						// that has since left the map) is remapped to the fresh
						// asset by that identity.
						const activeForRemap = editor.project.getActiveOrNull();
						if (activeForRemap) {
							for (const scene of activeForRemap.scenes ?? []) {
								const tracks = scene.tracks as unknown as {
									audio?: Array<{ elements?: Array<Record<string, unknown>> }>;
									main?: { elements?: Array<Record<string, unknown>> };
									overlay?: Array<{ elements?: Array<Record<string, unknown>> }>;
								};
								const allTrackElements = [
									...(tracks?.main?.elements ?? []),
									...(tracks?.overlay ?? []).flatMap((t) => t.elements ?? []),
									...(tracks?.audio ?? []).flatMap((t) => t.elements ?? []),
								];
								for (const element of allTrackElements) {
									const identity = element.videoFsArtifact as
										| { artifactId?: string }
										| undefined;
									const mediaId = element.mediaId;
									if (
										identity?.artifactId === asset.artifact.artifactId &&
										typeof mediaId === "string" &&
										mediaId !== added.id &&
										!known.has(mediaId)
									) {
										replacements.set(mediaId, added.id);
									}
								}
							}
							if (replacements.size) {
								const rewritten = rewriteProjectMediaIds({
									project: activeForRemap,
									replacements,
								});
								if (rewritten.changed) {
									editor.scenes.setScenes({
										activeSceneId: rewritten.project.currentSceneId,
										scenes: rewritten.project.scenes,
									});
									editor.project.setActiveProject({ project: rewritten.project });
									await storageService.saveProject({ project: rewritten.project });
								}
							}
						}
					}
				} catch {
					/* skip failed asset; retried next mount */
				}
			}
			if (!cancelled) {
				const didReconcile = await reconcileDuplicateHostMedia({
					editor,
					hostAssets: mediaAssets,
					map,
					projectId: opencutId,
				});
				if (didReconcile || mapChanged) writeHostMediaMap(mediaMapKey, map);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [opencutId, mediaAssets, mediaMapKey]);

	// Edit-document sync: push local saves up, pull agent edits down.
	useEffect(() => {
		if (!opencutId) return;
		let cancelled = false;
		let tickQueue = Promise.resolve();
		const tick = async () => {
			if (cancelled) return;
			try {
				// PULL FIRST: agent edits that landed between ticks must be applied
				// before any push — pushing first silently clobbered them.
				const docResponse = await fetch(`/api/projects/${hostProjectId}/editor-doc`);
				const doc = docResponse.ok ? await docResponse.json() : null;
				if (typeof doc?.revision === "number") {
					lastKnownRevisionRef.current = doc.revision;
					onDocumentRevisionChange?.(doc.revision);
				}
				let appliedAgentDoc = false;
				if (
					doc &&
					doc.source === "agent" &&
					typeof doc.revision === "number" &&
					doc.revision > lastAppliedRevisionRef.current &&
					doc.project
				) {
					try {
						// The wire doc is raw JSON — dates are STRINGS. saveProject
						// calls toISOString() on them, so hydrate first or the apply
						// throws and the agent's edit silently never reaches the
						// editor (and the next push clobbers it).
						await storageService.saveProject({
							project: hydrateWireProject(doc.project),
						});
						lastPushedRef.current = JSON.stringify(doc.project);
						await EditorCore.getInstance().project.loadProject({ id: opencutId });
						// Mark applied ONLY on success so a transient failure retries.
						lastAppliedRevisionRef.current = doc.revision;
						appliedAgentDoc = true;
						dispatchEditorDocumentRevision(window, {
							projectId: opencutId,
							revision: doc.revision,
						});
					} catch (caught) {
						console.warn("[editor-sync] failed to apply agent doc", caught);
					}
				}
				if (!appliedAgentDoc) {
					const loaded = await storageService.loadProject({ id: opencutId });
					const project = loaded?.project ?? null;
					if (project) {
						const serialized = JSON.stringify(project);
						if (serialized !== lastPushedRef.current) {
							const mediaMap = JSON.parse(
								window.localStorage.getItem(mediaMapKey) ?? "{}",
							);
							const response = await fetch(
								`/api/projects/${hostProjectId}/editor-doc`,
								{
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										baseRevision: lastKnownRevisionRef.current,
										mediaMap,
										project,
									}),
								},
							);
							// A 409 means an agent edit landed that this state does not
							// include — the next tick's pull applies it, then pushes.
							if (response.ok) {
								lastPushedRef.current = serialized;
								const pushed = await response.json().catch(() => null);
								if (typeof pushed?.revision === "number") {
									lastKnownRevisionRef.current = pushed.revision;
									onDocumentRevisionChange?.(pushed.revision);
									dispatchEditorDocumentRevision(window, {
										projectId: opencutId,
										revision: pushed.revision,
									});
								}
							}
						}
					}
				}
				// Drain queued agent placements once their media is in the bin.
				if (doc && Array.isArray(doc.pendingPlacements) && doc.pendingPlacements.length) {
					const TICKS = 120_000;
					const map: Record<
						string,
						{ durationSeconds?: number | null; kind?: string; mediaId: string; name: string }
					> = JSON.parse(window.localStorage.getItem(mediaMapKey) ?? "{}");
					const loadedForDrain = await storageService.loadProject({ id: opencutId });
					const current = loadedForDrain?.project ?? null;
					type DrainSceneDoc = {
						scenes?: Array<{
							id: string;
							isMain?: boolean;
							tracks?: {
								main?: { elements?: Array<Record<string, unknown>> };
								overlay?: Array<{
									elements?: Array<Record<string, unknown>>;
									hidden?: boolean;
									id?: string;
									muted?: boolean;
									name?: string;
									type?: string;
								}>;
							};
						}>;
						currentSceneId?: string;
					};
					const scenes = current as unknown as DrainSceneDoc | null;
					const scene =
						scenes?.scenes?.find((entry) => entry.id === scenes.currentSceneId) ??
						scenes?.scenes?.find((entry) => entry.isMain) ??
						scenes?.scenes?.[0];
					if (current && scene?.tracks && Array.isArray(scene.tracks.main?.elements)) {
						const remaining: Array<Record<string, unknown>> = [];
						let applied = 0;
						for (const raw of doc.pendingPlacements as Array<Record<string, unknown>>) {
							const hostMediaId =
								typeof raw.hostMediaId === "string" ? raw.hostMediaId : null;
							const mapped = hostMediaId ? map[hostMediaId] : null;
							if (!hostMediaId || !mapped) {
								remaining.push(raw);
								continue;
							}
							let elements = scene.tracks.main!.elements!;
							if (raw.track === "overlay") {
								scene.tracks.overlay = Array.isArray(scene.tracks.overlay)
									? scene.tracks.overlay
									: [];
								const overlayIndex =
									typeof raw.overlayIndex === "number" ? raw.overlayIndex : 0;
								while (scene.tracks.overlay.length <= overlayIndex) {
									scene.tracks.overlay.push({
										elements: [],
										hidden: false,
										id: crypto.randomUUID(),
										muted: false,
										name: `Overlay ${scene.tracks.overlay.length + 1}`,
										type: "video",
									});
								}
								const lane = scene.tracks.overlay[overlayIndex]!;
								lane.elements = Array.isArray(lane.elements) ? lane.elements : [];
								elements = lane.elements;
							}
							const isVideo = mapped.kind !== "image";
							const naturalSeconds =
								typeof raw.durationSeconds === "number"
									? raw.durationSeconds
									: isVideo
										? mapped.durationSeconds ?? 5
										: 5;
							const durationTicks = Math.max(1, Math.round(naturalSeconds * TICKS));
							const trackEnd = elements.reduce((max, element) => {
								const start = typeof element.startTime === "number" ? element.startTime : 0;
								const length = typeof element.duration === "number" ? element.duration : 0;
								return Math.max(max, start + length);
							}, 0);
							const startTime =
								typeof raw.atSeconds === "number"
									? Math.round(raw.atSeconds * TICKS)
									: trackEnd;
							elements.push({
								duration: durationTicks,
								id: crypto.randomUUID(),
								mediaId: mapped.mediaId,
								name: mapped.name || hostMediaId,
								params: {},
								startTime,
								trimEnd: 0,
								trimStart: 0,
								type: isVideo ? "video" : "image",
							});
							applied += 1;
						}
						if (applied > 0) {
							await storageService.saveProject({ project: current });
							await EditorCore.getInstance().project.loadProject({ id: opencutId });
							const serialized = JSON.stringify(current);
							lastPushedRef.current = serialized;
							const response = await fetch(`/api/projects/${hostProjectId}/editor-doc`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									mediaMap: map,
									pendingPlacements: remaining,
									project: current,
								}),
							});
							if (!response.ok) lastPushedRef.current = "";
						}
					}
				}
			} catch {
				/* transient; next tick retries */
			}
		};
		const requestTick = () => {
			tickQueue = tickQueue.then(tick, tick);
		};
		const events = new EventSource(`/api/projects/${hostProjectId}/events`);
		const onEditorCommand = (event: MessageEvent<string>) => {
			try {
				const payload = JSON.parse(event.data) as { kind?: string };
				if (payload.kind === "editor.command.completed") requestTick();
			} catch {
				// Ignore malformed events; the fallback sync still runs.
			}
		};
		events.addEventListener(
			"editor-command",
			onEditorCommand as EventListener,
		);
		const interval = window.setInterval(requestTick, 4000);
		requestTick();
		return () => {
			cancelled = true;
			window.clearInterval(interval);
			events.removeEventListener(
				"editor-command",
				onEditorCommand as EventListener,
			);
			events.close();
		};
	}, [
		hostProjectId,
		mediaMapKey,
		onDocumentRevisionChange,
		opencutId,
	]);
}

function HostEditorBridge({
	exportRequestId,
	focusedArtifact,
	focusedPlacement,
	mediaAssets,
	onAgentContextChange,
	onExportStatusChange,
	opencutId,
	projectId,
}: {
	exportRequestId: number;
	focusedArtifact: AgentContextArtifact | null;
	focusedPlacement: EditorAgentContext["focusedPlacement"];
	mediaAssets: HostEditorMediaAsset[];
	onAgentContextChange?: (context: EditorAgentContext) => void;
	onExportStatusChange?: (status: HostEditorExportStatus) => void;
	opencutId: string;
	projectId: string;
}) {
	const [documentRevision, setDocumentRevision] = useState<number | null>(null);
	useHostBridge(projectId, opencutId, mediaAssets, setDocumentRevision);
	return (
		<>
			<HostAgentContextBridge
				documentRevision={documentRevision}
				focusedArtifact={focusedArtifact}
				focusedPlacement={focusedPlacement}
				onAgentContextChange={onAgentContextChange}
			/>
			<HostExportBridge
				exportRequestId={exportRequestId}
				onExportStatusChange={onExportStatusChange}
			/>
		</>
	);
}

export default function OpencutEditorMount({
	active = true,
	exportRequestId = 0,
	focusRequest = null,
	onAgentContextChange,
	onExportStatusChange,
	onShowSource,
	projectId,
	projectName,
	mediaAssets = [],
}: {
	active?: boolean;
	exportRequestId?: number;
	focusRequest?: ArtifactFocusRequest | null;
	onAgentContextChange?: (context: EditorAgentContext) => void;
	onExportStatusChange?: (status: HostEditorExportStatus) => void;
	onShowSource?: (request: {
		artifact: ArtifactFocusIdentity;
		relink?: boolean;
	}) => Promise<ArtifactFocusResult>;
	projectId: string;
	projectName: string;
	mediaAssets?: HostEditorMediaAsset[];
}) {
	const opencutId = useOpencutProjectId(projectId, projectName);
	const [focusedArtifact, setFocusedArtifact] =
		useState<AgentContextArtifact | null>(null);
	const [focusedPlacement, setFocusedPlacement] =
		useState<EditorAgentContext["focusedPlacement"]>(null);
	if (!opencutId) {
		return (
			<div
				className="opencut-scope flex h-full w-full"
				data-host-editor-active={active ? "true" : "false"}
			/>
		);
	}
	return (
		<div
			className="opencut-scope flex h-full w-full flex-col overflow-visible"
			data-host-editor-active={active ? "true" : "false"}
		>
			<TooltipProvider>
				<EditorProvider projectId={opencutId}>
					<div className="flex h-full w-full flex-col overflow-visible">
						<HostEditorBridge
							exportRequestId={exportRequestId}
							focusedArtifact={focusedArtifact}
							focusedPlacement={focusedPlacement}
							mediaAssets={mediaAssets}
							onAgentContextChange={onAgentContextChange}
							onExportStatusChange={onExportStatusChange}
							opencutId={opencutId}
							projectId={projectId}
						/>
						<div className="min-h-0 min-w-0 flex-1">
							<SceneReadyGate>
								<EditorLayout
									focusRequest={focusRequest}
									mediaAssets={mediaAssets}
									onFocusedArtifactChange={setFocusedArtifact}
									onFocusedPlacementChange={setFocusedPlacement}
									onShowSource={onShowSource}
									opencutId={opencutId}
								/>
							</SceneReadyGate>
						</div>
						<MigrationDialog />
					</div>
				</EditorProvider>
			</TooltipProvider>
		</div>
	);
}

function HostAgentContextBridge({
	documentRevision,
	focusedArtifact,
	focusedPlacement,
	onAgentContextChange,
}: {
	documentRevision: number | null;
	focusedArtifact: AgentContextArtifact | null;
	focusedPlacement: EditorAgentContext["focusedPlacement"];
	onAgentContextChange?: (context: EditorAgentContext) => void;
}) {
	const project = useEditor((editor) => editor.project.getActiveOrNull());
	const scene = useEditor((editor) => editor.scenes.getActiveSceneOrNull());
	const playheadTicks = useEditor((editor) => editor.playback.getCurrentTime());
	const selectedElements = useEditor((editor) =>
		editor.selection.getSelectedElements(),
	);
	const selectedKeyframes = useEditor((editor) =>
		editor.selection.getSelectedKeyframes(),
	);
	const selectedMaskPoints = useEditor((editor) =>
		editor.selection.getSelectedMaskPointSelection(),
	);
	const context = useMemo(
		() =>
			editorAgentContextSnapshot({
				documentRevision,
				focusedArtifact,
				focusedPlacement,
				playheadTicks,
				project,
				scene,
				selection: {
					selectedElements: selectedElementsForFocusedPlacement({
						focusedPlacement,
						selectedElements,
					}),
					selectedKeyframes,
					selectedMaskPoints,
				},
			}),
		[
			documentRevision,
			focusedArtifact,
			focusedPlacement,
			playheadTicks,
			project,
			scene,
			selectedElements,
			selectedKeyframes,
			selectedMaskPoints,
		],
	);
	useEffect(() => {
		onAgentContextChange?.(context);
	}, [context, onAgentContextChange]);
	return null;
}

type HostArtifactFocusState =
	| {
			identity: ArtifactFocusIdentity;
			mediaId: string;
			status: "media-bin";
	  }
	| {
			elementId: string;
			identity: ArtifactFocusIdentity;
			revision: number | null;
			status: "focused-placement";
	  }
	| {
			identity: ArtifactFocusIdentity;
			mediaId: string | null;
			placements: HostTimelinePlacement[];
			removedElementId: string | null;
			status: "choose-placement";
	  }
	| {
			identity: ArtifactFocusIdentity;
			mediaId: string | null;
			placements: HostTimelinePlacement[];
			removedElementId: string;
			revision: number;
			status: "removed-placement";
	  }
	| null;

function HostArtifactFocusSurface({
	focusRequest,
	mediaAssets,
	onFocusedArtifactChange,
	onFocusedPlacementChange,
	onShowSource,
	opencutId,
}: {
	focusRequest: ArtifactFocusRequest | null;
	mediaAssets: HostEditorMediaAsset[];
	onFocusedArtifactChange: (artifact: AgentContextArtifact | null) => void;
	onFocusedPlacementChange: (
		placement: EditorAgentContext["focusedPlacement"],
	) => void;
	onShowSource?: (request: {
		artifact: ArtifactFocusIdentity;
		relink?: boolean;
	}) => Promise<ArtifactFocusResult>;
	opencutId: string;
}) {
	const editor = useEditor();
	const project = useEditor((instance) => instance.project.getActiveOrNull());
	const selectedElements = useEditor((instance) =>
		instance.selection.getSelectedElements(),
	);
	const requestRevealMedia = useAssetsPanelStore(
		(state) => state.requestRevealMedia,
	);
	const [focusState, setFocusState] = useState<HostArtifactFocusState>(null);
	const focusStateRef = useRef<HostArtifactFocusState>(null);
	const latestRevisionRef = useRef<number | null>(null);
	useEffect(() => {
		focusStateRef.current = focusState;
	}, [focusState]);
	const [relinkedPlacement, setRelinkedPlacement] = useState<{
		elementId: string;
		requestNonce: number;
	} | null>(null);
	const mediaMapKey = `host-media-map-${opencutId}`;

	useEffect(() => {
		if (!focusRequest || !project) return;
		let cancelled = false;
		let timer: number | null = null;
		let attempt = 0;
		const focus = async () => {
			if (cancelled) return;
			const map = readHostMediaMap(mediaMapKey);
			const mappedEntries = Object.values(map).filter((entry) => {
				const mapped = mappedArtifactIdentity(entry);
				return mapped
					? artifactFocusIdentityMatches(mapped, focusRequest)
					: false;
			});
			const placements = timelinePlacementsForArtifact({
				identity: focusRequest,
				map,
				project: editor.project.getActiveOrNull(),
			});
			if (!mappedEntries.length && !placements.length && attempt < 40) {
				attempt += 1;
				timer = window.setTimeout(() => void focus(), 100);
				return;
			}
			if (
				!mappedEntries.length &&
				!placements.length &&
				focusRequest.timelineElementId
			) {
				editor.selection.setSelectedElements({ elements: [] });
				setFocusState({
					identity: focusRequest,
					mediaId: null,
					placements: [],
					removedElementId: focusRequest.timelineElementId,
					revision: 0,
					status: "removed-placement",
				});
				return;
			}
			if (!mappedEntries.length && !placements.length) {
				setFocusState(null);
				return;
			}
			const retainedState = focusStateRef.current;
			const retainedElementId =
				retainedState &&
				artifactFocusIdentityMatches(retainedState.identity, focusRequest) &&
				retainedState.status === "focused-placement"
					? retainedState.elementId
					: retainedState?.status === "removed-placement" &&
						  artifactFocusIdentityMatches(retainedState.identity, focusRequest)
						? retainedState.removedElementId
						: retainedState?.status === "choose-placement" &&
								  artifactFocusIdentityMatches(
										retainedState.identity,
										focusRequest,
								  )
								? retainedState.removedElementId
								: null;
			const requestedElementId =
				relinkedPlacement?.requestNonce === focusRequest.nonce
						? relinkedPlacement.elementId
						: (focusRequest.timelineElementId ?? retainedElementId);
			const target = resolveArtifactFocusTarget({
				mediaId: mappedEntries[0]?.mediaId ?? null,
				placements,
				timelineElementId: requestedElementId,
			});
			if (target.status === "removed-placement") {
				editor.selection.setSelectedElements({ elements: [] });
				setFocusState({
					identity: focusRequest,
					mediaId: mappedEntries[0]?.mediaId ?? null,
					placements,
					removedElementId: target.removedElementId,
					revision: 0,
					status: "removed-placement",
				});
				return;
			}
			if (target.status === "stale") {
				setFocusState(null);
				return;
			}
			if (target.status === "choose-placement") {
				setFocusState({
					identity: focusRequest,
					mediaId: mappedEntries[0]?.mediaId ?? null,
					placements,
					removedElementId: null,
					status: "choose-placement",
				});
				return;
			}
			if (target.status === "focused-placement") {
				const placement = placements.find(
					(entry) => entry.elementId === target.elementId,
				)!;
				if (editor.scenes.getActiveSceneOrNull()?.id !== placement.sceneId) {
					await editor.scenes.switchToScene({
						sceneId: placement.sceneId,
					});
				}
				const ref: ElementRef = {
					elementId: placement.elementId,
					trackId: placement.trackId,
				};
				editor.selection.setSelectedElements({ elements: [ref] });
				editor.playback.seek({ time: placement.element.startTime });
					setFocusState({
						elementId: placement.elementId,
						identity: focusRequest,
						revision: latestRevisionRef.current,
					status: "focused-placement",
				});
				return;
			}
			const mediaId = target.mediaId;
			editor.selection.setSelectedElements({ elements: [] });
			requestRevealMedia(mediaId);
			setFocusState({
				identity: focusRequest,
				mediaId,
				status: "media-bin",
			});
		};
		void focus();
		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [
		editor,
		focusRequest,
		mediaMapKey,
		project,
		relinkedPlacement,
		requestRevealMedia,
	]);

	useEffect(
		() =>
			subscribeToRemovedPlacement({
				clearSelection: () =>
					editor.selection.setSelectedElements({ elements: [] }),
				eventTarget: window,
				getFocusedPlacement: () => {
					const current = focusStateRef.current;
					return current?.status === "focused-placement"
						? {
								elementId: current.elementId,
								identity: current.identity,
								revision: current.revision,
							}
						: null;
				},
				getPlacements: (identity) =>
					timelinePlacementsForArtifact({
						identity,
						map: readHostMediaMap(mediaMapKey),
						project: editor.project.getActiveOrNull(),
					}),
				onRemoved: ({
					identity,
					placements,
					removedElementId,
					revision,
				}) => {
					const map = readHostMediaMap(mediaMapKey);
					const mediaId =
						Object.values(map).find((entry) => {
							const mapped = mappedArtifactIdentity(entry);
							return mapped
								? artifactFocusIdentityMatches(mapped, identity)
								: false;
						})?.mediaId ?? null;
					setFocusState({
						identity,
						mediaId,
						placements,
						removedElementId,
						revision,
					status: "removed-placement",
					});
				},
				onRevision: ({ revision }) => {
					latestRevisionRef.current = revision;
				},
				projectId: opencutId,
			}),
		[editor, mediaMapKey, opencutId],
	);

	const selectedArtifact = useMemo(() => {
		if (selectedElements.length !== 1) return null;
		const [selected] = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		});
		if (!selected) return null;
		const embedded = elementArtifactIdentity(selected.element);
		if (embedded) return embedded;
		const mediaId =
			"mediaId" in selected.element &&
			typeof selected.element.mediaId === "string"
				? selected.element.mediaId
				: null;
		if (!mediaId) return null;
		const map = readHostMediaMap(mediaMapKey);
		return mappedArtifactIdentity(
			Object.values(map).find((entry) => entry.mediaId === mediaId),
		);
	}, [editor, mediaMapKey, selectedElements]);
	const explicitContinuityState =
		focusRequest &&
		focusState &&
		artifactFocusIdentityMatches(focusState.identity, focusRequest) &&
		(focusState.status === "removed-placement" ||
			(focusState.status === "choose-placement" &&
				focusState.removedElementId))
				? focusState
				: null;
	const identity =
		explicitContinuityState?.identity ??
		selectedArtifact ??
		focusState?.identity ??
		null;
	const focusedArtifact = useMemo(() => {
		if (!identity) return null;
		const asset = mediaAssets.find(
			(candidate) =>
				candidate.artifact.artifactId === identity.artifactId &&
				candidate.artifact.versionId === identity.versionId &&
				candidate.artifact.versionIndex === identity.versionIndex,
		);
		return {
			artifactId: identity.artifactId,
			contentHash: identity.contentHash,
			entityRevision: identity.entityRevision,
			kind: asset?.kind ?? "media",
			path: identity.sourcePath,
			title: asset?.title ?? null,
			version:
				identity.versionId !== null && identity.versionIndex !== null
					? {
							index: identity.versionIndex,
							sha256: identity.versionHash,
							versionId: identity.versionId,
						}
					: null,
		} satisfies AgentContextArtifact;
	}, [identity, mediaAssets]);
	useEffect(() => {
		onFocusedArtifactChange(focusedArtifact);
		return () => onFocusedArtifactChange(null);
	}, [focusedArtifact, onFocusedArtifactChange]);
	const applicableFocusState =
		identity !== null && focusState !== null
			? artifactFocusIdentityMatches(focusState.identity, identity)
				? focusState
				: null
			: null;
	const focusedPlacement = useMemo(() => {
		if (!applicableFocusState) return null;
		if (applicableFocusState.status === "focused-placement") {
			return {
				elementId: applicableFocusState.elementId,
				status: "focused" as const,
			};
		}
		if (
			(applicableFocusState.status === "removed-placement" ||
				applicableFocusState.status === "choose-placement") &&
			applicableFocusState.removedElementId
		) {
			return {
				elementId: applicableFocusState.removedElementId,
				status: "removed" as const,
			};
		}
		return null;
	}, [applicableFocusState]);
	useEffect(() => {
		onFocusedPlacementChange(focusedPlacement);
		return () => onFocusedPlacementChange(null);
	}, [focusedPlacement, onFocusedPlacementChange]);
	// The focus bridge is headless: it drives selection, scene focus, and
	// agent context, but renders no chrome of its own.
	return null;
}

function HostExportBridge({
	exportRequestId,
	onExportStatusChange,
}: {
	exportRequestId: number;
	onExportStatusChange?: (status: HostEditorExportStatus) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const exportState = useEditor((e) => e.project.getExportState());
	const lastHandledRequestRef = useRef(0);
	const lastExportStatusRef = useRef<HostEditorExportStatus | null>(null);
	const lastDownloadUrlRef = useRef<string | null>(null);
	const emitExportStatus = useCallback(
		(status: HostEditorExportStatus) => {
			if (exportStatusesEqual(lastExportStatusRef.current, status)) return;
			lastExportStatusRef.current = status;
			onExportStatusChange?.(status);
		},
		[onExportStatusChange],
	);

	useEffect(() => {
		if (exportState.isExporting && activeProject) {
			showExportProgressToast({
				progress: exportState.progress,
				projectName: activeProject.metadata.name,
			});
		}
		emitExportStatus({
			available: !!activeProject,
			error:
				exportState.result && !exportState.result.success
					? exportState.result.error ?? "Export failed."
					: null,
			isExporting: exportState.isExporting,
			progress: exportState.progress,
		});
	}, [activeProject, emitExportStatus, exportState]);

	useEffect(() => {
		return () => {
			if (lastDownloadUrlRef.current) {
				URL.revokeObjectURL(lastDownloadUrlRef.current);
				lastDownloadUrlRef.current = null;
			}
			emitExportStatus({
				available: false,
				error: null,
				isExporting: false,
				progress: 0,
			});
		};
	}, [emitExportStatus]);

	useEffect(() => {
		if (!exportRequestId || exportRequestId === lastHandledRequestRef.current) {
			return;
		}
		if (!activeProject) {
			emitExportStatus({
				available: false,
				error: null,
				isExporting: true,
				progress: 0,
			});
			return;
		}

		let cancelled = false;
		lastHandledRequestRef.current = exportRequestId;

		const exportMp4 = async () => {
			const format = "mp4" as const;
			showExportProgressToast({
				progress: 0,
				projectName: activeProject.metadata.name,
			});
			emitExportStatus({
				available: true,
				error: null,
				isExporting: true,
				progress: 0,
			});

			try {
				const result = await editor.project.export({
					options: {
						...DEFAULT_EXPORT_OPTIONS,
						format,
						fps: activeProject.settings.fps,
						includeAudio: true,
					},
				});
				if (cancelled) return;

				if (result.cancelled) {
					editor.project.clearExportState();
					toast.dismiss(EXPORT_PROGRESS_TOAST_ID);
					emitExportStatus({
						available: true,
						error: null,
						isExporting: false,
						progress: 0,
					});
					return;
				}

				if (result.success && result.buffer) {
					if (lastDownloadUrlRef.current) {
						URL.revokeObjectURL(lastDownloadUrlRef.current);
					}
					const filename = `${activeProject.metadata.name}${getExportFileExtension({
						format,
					})}`;
					const blob = new Blob([result.buffer], {
						type: getExportMimeType({ format }),
					});
					const url = URL.createObjectURL(blob);
					lastDownloadUrlRef.current = url;
					triggerDownloadUrl({ filename, url });
					editor.project.clearExportState();
					showExportReadyToast({
						filename,
						projectName: activeProject.metadata.name,
						url,
					});
					emitExportStatus({
						available: true,
						error: null,
						isExporting: false,
						progress: 1,
					});
					return;
				}

				const error = result.error ?? "Export failed.";
				showExportFailedToast({ message: error });
				emitExportStatus({
					available: true,
					error,
					isExporting: false,
					progress: 0,
				});
			} catch (error) {
				if (cancelled) return;
				const message =
					error instanceof Error ? error.message : "Export failed.";
				showExportFailedToast({ message });
				emitExportStatus({
					available: true,
					error: message,
					isExporting: false,
					progress: 0,
				});
			}
		};

		void exportMp4();

		return () => {
			cancelled = true;
		};
	}, [activeProject, editor, emitExportStatus, exportRequestId]);

	return null;
}

/* Mirrors EditorLayout from opencut/app/editor/[project_id]/page.tsx (the
   original is not exported). Vendored code is frozen, so drift risk is nil. */
// A freshly created project briefly has zero scenes while the doc loads;
// timeline hooks call getActiveScene() unconditionally, so hold the editor
// UI back until a scene exists.
function SceneReadyGate({ children }: { children: React.ReactNode }) {
	const hasScene = useEditor(
		(editor) => editor.scenes.getActiveSceneOrNull() !== null,
	);
	if (!hasScene) {
		return (
			<div className="flex h-full w-full items-center justify-center">
				<div className="size-2 animate-pulse rounded-full bg-muted-foreground/40" />
			</div>
		);
	}
	return <>{children}</>;
}

function EditorLayout({
	focusRequest,
	mediaAssets,
	onFocusedArtifactChange,
	onFocusedPlacementChange,
	onShowSource,
	opencutId,
}: {
	focusRequest: ArtifactFocusRequest | null;
	mediaAssets: HostEditorMediaAsset[];
	onFocusedArtifactChange: (artifact: AgentContextArtifact | null) => void;
	onFocusedPlacementChange: (
		placement: EditorAgentContext["focusedPlacement"],
	) => void;
	onShowSource?: (request: {
		artifact: ArtifactFocusIdentity;
		relink?: boolean;
	}) => Promise<ArtifactFocusResult>;
	opencutId: string;
}) {
	usePasteMedia();
	const { panels, setPanel } = usePanelStore();
	const activeScene = useEditor((editor) =>
		editor.scenes.getActiveSceneOrNull(),
	);
	const currentTime = useEditor((editor) => editor.playback.getCurrentTime());
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[activeGuide, activeScene, currentTime, showBookmarkNotes],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full"
			onLayout={(sizes: number[]) => {
				setPanel({
					panel: "mainContent",
					size: sizes[0] ?? panels.mainContent,
				});
				setPanel({
					panel: "timeline",
					size: sizes[1] ?? panels.timeline,
				});
			}}
		>
			<ResizablePanel
				defaultSize={panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full"
					onLayout={(sizes: number[]) => {
						setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
						setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
						setPanel({
							panel: "properties",
							size: sizes[2] ?? panels.properties,
						});
					}}
				>
					<ResizablePanel
						defaultSize={panels.tools}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle withHandle className="w-2 data-[panel-group-direction=vertical]:h-2" />

					<ResizablePanel
						defaultSize={panels.preview}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						<PreviewPanel
							overlayControls={overlayControls}
							overlayInstances={overlaySource.instances}
							onOverlayVisibilityChange={setOverlayVisibility}
						/>
					</ResizablePanel>

					<ResizableHandle withHandle className="w-2 data-[panel-group-direction=vertical]:h-2" />

					<ResizablePanel
						defaultSize={panels.properties}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<div
							className="flex h-full min-h-0 flex-col"
							data-host-properties-panel=""
						>
							<HostArtifactFocusSurface
								focusRequest={focusRequest}
								mediaAssets={mediaAssets}
								onFocusedArtifactChange={onFocusedArtifactChange}
								onFocusedPlacementChange={onFocusedPlacementChange}
								onShowSource={onShowSource}
								opencutId={opencutId}
							/>
							<div className="min-h-0 flex-1">
								<PropertiesPanel />
							</div>
						</div>
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle className="w-2 data-[panel-group-direction=vertical]:h-2" />

			<ResizablePanel
				defaultSize={panels.timeline}
				minSize={15}
				maxSize={70}
				className="min-h-0"
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
