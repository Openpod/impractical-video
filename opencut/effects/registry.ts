import { DefinitionRegistry } from "@opencut/params/registry";
import type { EffectDefinition } from "@opencut/effects/types";

export class EffectsRegistry extends DefinitionRegistry<string, EffectDefinition> {
	constructor() {
		super("effect");
	}
}

export const effectsRegistry = new EffectsRegistry();
