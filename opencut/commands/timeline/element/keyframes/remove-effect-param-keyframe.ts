import { EditorCore } from "@opencut/core";
import { Command, type CommandResult } from "@opencut/commands/base-command";
import { removeEffectParamKeyframe } from "@opencut/animation/effect-param-channel";
import { updateElementInSceneTracks } from "@opencut/timeline";
import { isVisualElement } from "@opencut/timeline/element-utils";
import type { SceneTracks } from "@opencut/timeline";

export class RemoveEffectParamKeyframeCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectId: string;
	private readonly paramKey: string;
	private readonly keyframeId: string;

	constructor({
		trackId,
		elementId,
		effectId,
		paramKey,
		keyframeId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
		keyframeId: string;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectId = effectId;
		this.paramKey = paramKey;
		this.keyframeId = keyframeId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isVisualElement,
			update: (element) => {
				const animations = removeEffectParamKeyframe({
					animations: element.animations,
					effectId: this.effectId,
					paramKey: this.paramKey,
					keyframeId: this.keyframeId,
				});
				return { ...element, animations };
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
