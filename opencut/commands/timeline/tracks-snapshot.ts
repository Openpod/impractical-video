import { Command, type CommandResult } from "@opencut/commands/base-command";
import type { SceneTracks } from "@opencut/timeline";
import { EditorCore } from "@opencut/core";

export class TracksSnapshotCommand extends Command {
	constructor({
		before,
		after,
	}: {
		before: SceneTracks;
		after: SceneTracks;
	}) {
		super();
		this.before = before;
		this.after = after;
	}

	private before: SceneTracks;
	private after: SceneTracks;

	execute(): CommandResult | undefined {
		EditorCore.getInstance().timeline.updateTracks(this.after);
		return undefined;
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
