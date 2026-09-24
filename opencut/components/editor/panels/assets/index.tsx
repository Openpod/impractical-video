"use client";

import { Separator } from "@opencut/components/ui/separator";
import {
	isAssetsPanelTabVisible,
	type Tab,
	useAssetsPanelStore,
} from "@opencut/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "@opencut/subtitles/components/assets-view";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { SoundsView } from "@opencut/sounds/components/assets-view";
import { StickersView } from "@opencut/stickers/components/assets-view";
import { TextView } from "@opencut/text/components/assets-view";
import { EffectsView } from "@opencut/effects/components/assets-view";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();
	const visibleActiveTab = isAssetsPanelTabVisible(activeTab)
		? activeTab
		: "media";

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: <EffectsView />,
		transitions: (
			<div className="text-muted-foreground p-4">
				Transitions view coming soon...
			</div>
		),
		captions: <Captions />,
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[visibleActiveTab]}</div>
		</div>
	);
}
