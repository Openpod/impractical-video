// Ambient declarations required by the vendored opencut-classic editor tree.

// The EyeDropper API (Chromium) has no lib.dom typing yet.
interface EyeDropperResult {
	sRGBHex: string;
}

declare class EyeDropper {
	open(options?: { signal?: AbortSignal }): Promise<EyeDropperResult>;
}

declare module "soundtouchjs";
