import { Command, type CommandResult } from "@opencut/commands/base-command";
import { EditorCore } from "@opencut/core";
import type {
	CreateTimelineElement,
	SceneTracks,
} from "@opencut/timeline";
import { generateUUID } from "@opencut/utils/id";
import type { MediaAsset } from "@opencut/media/types";
import { floatToFrameRate } from "@opencut/fps/utils";
import { graphicsRegistry, registerDefaultGraphics } from "@opencut/graphics";
import {
	applyInsertElementMutation,
	type InsertElementPlacement,
} from "./mutations";

export interface InsertElementParams {
	element: CreateTimelineElement;
	placement: InsertElementPlacement;
}

export class InsertElementCommand extends Command {
	private elementId: string;
	private savedState: SceneTracks | null = null;
	private targetTrackId: string | null = null;

	constructor({ element, placement }: InsertElementParams) {
		super();
		this.elementId = generateUUID();
		this.element = element;
		this.placement = placement;
	}

	private element: CreateTimelineElement;
	private placement: InsertElementPlacement;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		if (this.element.type === "graphic") {
			registerDefaultGraphics();
			if (
				!this.element.definitionId ||
				!graphicsRegistry.has(this.element.definitionId)
			) {
				console.error("Graphic element must have a valid definitionId");
				return;
			}
		}

		const totalElementsInTimeline =
			this.savedState.main.elements.length +
			this.savedState.overlay.reduce(
				(total, track) => total + track.elements.length,
				0,
			) +
			this.savedState.audio.reduce(
				(total, track) => total + track.elements.length,
				0,
			);
		const isFirstElement = totalElementsInTimeline === 0;

		const updateResult = applyInsertElementMutation({
			tracks: this.savedState,
			element: this.element,
			elementId: this.elementId,
			placement: this.placement,
		});

		if (!updateResult) {
			return;
		}

		const { element: newElement, updatedTracks, targetTrackId } = updateResult;
		this.targetTrackId = targetTrackId;

		const isVisualMedia =
			newElement.type === "video" || newElement.type === "image";

		if (isFirstElement && isVisualMedia) {
			const mediaAssets = editor.media.getAssets();
			const activeProject = editor.project.getActive();
			const asset = mediaAssets.find(
				(item: MediaAsset) => item.id === newElement.mediaId,
			);

			if (asset?.width && asset?.height) {
				const nextCanvasSize = { width: asset.width, height: asset.height };
				const shouldSetOriginalCanvasSize =
					!activeProject?.settings.originalCanvasSize;
				editor.project.updateSettings({
					settings: {
						canvasSize: nextCanvasSize,
						...(shouldSetOriginalCanvasSize
							? { originalCanvasSize: nextCanvasSize }
							: {}),
					},
					pushHistory: false,
				});
			}

			if (asset?.type === "video" && asset?.fps) {
				editor.project.updateSettings({
					settings: { fps: floatToFrameRate(asset.fps) },
					pushHistory: false,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements: [
					{ trackId: targetTrackId, elementId: this.elementId },
				],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getElementId(): string {
		return this.elementId;
	}

	getTrackId(): string | null {
		return this.targetTrackId;
	}
}
