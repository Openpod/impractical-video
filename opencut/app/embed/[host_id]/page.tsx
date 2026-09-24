"use client";

// Host-integration bootstrap (video-fs-agent fork addition — NOT upstream
// code). The host app embeds the editor per host-project; this route maps the
// host project id to a stable OpenCut project (creating it once), applies the
// host's theme, marks embed mode for the chrome-hiding skin, then hands off
// to the stock /editor route untouched.

import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { EditorCore } from "@opencut/core";

const HOST_PROJECT_MAP_KEY = "host-project-map";

function readMap(): Record<string, string> {
	try {
		const raw = window.localStorage.getItem(HOST_PROJECT_MAP_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export default function HostEmbedBootstrap() {
	const params = useParams();
	const router = useRouter();
	const search = useSearchParams();
	const { setTheme } = useTheme();
	const hostId = typeof params.host_id === "string" ? params.host_id : "";

	useEffect(() => {
		if (!hostId) return;
		const theme = search.get("theme");
		if (theme === "light" || theme === "dark") setTheme(theme);
		document.documentElement.classList.add("host-embed");

		let cancelled = false;
		(async () => {
			const map = readMap();
			const editor = EditorCore.getInstance();
			let targetId = typeof map[hostId] === "string" ? map[hostId] : null;
			if (targetId) {
				try {
					await editor.project.loadProject({ id: targetId });
				} catch {
					targetId = null;
				}
			}
			if (!targetId) {
				targetId = await editor.project.createNewProject({
					name: search.get("name") || "Project edit",
				});
				const next = readMap();
				next[hostId] = targetId;
				window.localStorage.setItem(
					HOST_PROJECT_MAP_KEY,
					JSON.stringify(next),
				);
			}
			if (!cancelled) router.replace(`/editor/${targetId}`);
		})();
		return () => {
			cancelled = true;
		};
	}, [hostId, router, search, setTheme]);

	return null;
}
