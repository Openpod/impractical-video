import type { StickerProvider } from "@opencut/stickers/types";
import { DefinitionRegistry } from "@opencut/params/registry";

export class StickersRegistry extends DefinitionRegistry<string, StickerProvider> {
	constructor() {
		super("sticker provider");
	}
}

export const stickersRegistry = new StickersRegistry();
