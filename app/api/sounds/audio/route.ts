import { type NextRequest, NextResponse } from "next/server";

const ALLOWED_SOUND_HOSTS = new Set(["cdn.freesound.org", "freesound.org"]);

function isAllowedSoundUrl(url: URL) {
	return (
		(url.protocol === "https:" || url.protocol === "http:") &&
		ALLOWED_SOUND_HOSTS.has(url.hostname)
	);
}

export async function GET(request: NextRequest) {
	const rawUrl = request.nextUrl.searchParams.get("url");
	if (!rawUrl) {
		return NextResponse.json({ error: "Missing sound URL" }, { status: 400 });
	}

	let sourceUrl: URL;
	try {
		sourceUrl = new URL(rawUrl);
	} catch {
		return NextResponse.json({ error: "Invalid sound URL" }, { status: 400 });
	}

	if (!isAllowedSoundUrl(sourceUrl)) {
		return NextResponse.json({ error: "Sound URL not allowed" }, { status: 400 });
	}

	const headers = new Headers();
	const range = request.headers.get("range");
	if (range) {
		headers.set("range", range);
	}

	const response = await fetch(sourceUrl, { headers });
	if (!response.ok && response.status !== 206) {
		return NextResponse.json(
			{ error: "Failed to fetch sound" },
			{ status: response.status },
		);
	}

	const responseHeaders = new Headers({
		"Content-Type": response.headers.get("content-type") ?? "audio/mpeg",
		"Accept-Ranges": response.headers.get("accept-ranges") ?? "bytes",
		"Cache-Control": "public, max-age=86400",
	});
	const contentLength = response.headers.get("content-length");
	const contentRange = response.headers.get("content-range");
	if (contentLength) {
		responseHeaders.set("Content-Length", contentLength);
	}
	if (contentRange) {
		responseHeaders.set("Content-Range", contentRange);
	}

	return new NextResponse(response.body, {
		status: response.status,
		headers: responseHeaders,
	});
}
