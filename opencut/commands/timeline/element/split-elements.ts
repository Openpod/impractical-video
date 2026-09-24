import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@opencut/commands/base-command";
import type { SceneTracks } from "@opencut/timeline";
import { generateUUID } from "@opencut/utils/id";
import { EditorCore } from "@opencut/core";
import { type MediaTime } from "@opencut/wasm";
import { applySplitElementsMutation } from "./mutations";

export class SplitElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private rightSideElements: { trackId: string; elementId: string }[] = [];
	private readonly elements: { trackId: string; elementId: string }[];
	private readonly splitTime: MediaTime;
	private readonly retainSide: "both" | "left" | "right";

	constructor({
		elements,
		splitTime,
		retainSide = "both",
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}) {
		super();
		this.elements = elements;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
	}

	getRightSideElements(): { trackId: string; elementId: string }[] {
		return this.rightSideElements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const { rightSideElements, updatedTracks } =
			applySplitElementsMutation({
				createId: generateUUID,
				elements: this.elements,
				retainSide: this.retainSide,
				splitTime: this.splitTime,
				tracks: this.savedState,
			});
		this.rightSideElements = rightSideElements;

		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideElements.length > 0) {
			return createElementSelectionResult(this.rightSideElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
