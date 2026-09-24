import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@opencut/commands/base-command";
import { EditorCore } from "@opencut/core";
import type { SceneTracks } from "@opencut/timeline";
import type {
	PlannedElementMove,
	PlannedTrackCreation,
} from "@opencut/timeline/group-move";
import { applyMoveElementsMutation } from "./mutations";

export class MoveElementCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({
		moves,
		createTracks = [],
	}: {
		moves: PlannedElementMove[];
		createTracks?: PlannedTrackCreation[];
	}) {
		super();
		this.moves = moves;
		this.createTracks = createTracks;
	}

	private readonly moves: PlannedElementMove[];
	private readonly createTracks: PlannedTrackCreation[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const updatedTracks = applyMoveElementsMutation({
			createTracks: this.createTracks,
			moves: this.moves,
			tracks: this.savedState,
		});

		editor.timeline.updateTracks(updatedTracks);
		return createElementSelectionResult(
			this.moves.map(({ elementId, targetTrackId }) => ({
				trackId: targetTrackId,
				elementId,
			})),
		);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
