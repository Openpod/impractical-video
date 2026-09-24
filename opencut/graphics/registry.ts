import { DefinitionRegistry } from "@opencut/params/registry";
import type { GraphicDefinition } from "./types";

export class GraphicsRegistry extends DefinitionRegistry<string, GraphicDefinition> {
	constructor() {
		super("graphic");
	}
}

export const graphicsRegistry = new GraphicsRegistry();
