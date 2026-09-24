import { EditorCore } from "@opencut/core";
import { Command, type CommandResult } from "@opencut/commands/base-command";
import type { SceneTracks, TimelineElement } from "@opencut/timeline";
import { applyUpdateElementsMutation } from "./mutations";

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}>;

	constructor({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
		}>;
	}) {
		super();
		this.updates = updates;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const updatedTracks = applyUpdateElementsMutation({
			tracks: this.savedState,
			updates: this.updates,
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
