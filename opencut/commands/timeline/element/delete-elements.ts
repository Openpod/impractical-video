import { Command, type CommandResult } from "@opencut/commands/base-command";
import type { SceneTracks } from "@opencut/timeline";
import { EditorCore } from "@opencut/core";
import { applyDeleteElementsMutation } from "./mutations";

export class DeleteElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly elements: { trackId: string; elementId: string }[];

	constructor({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}) {
		super();
		this.elements = elements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = applyDeleteElementsMutation({
			elements: this.elements,
			tracks: this.savedState,
		});

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements: [],
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
}
