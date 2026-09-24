export function desktopCloudConfiguration(environment = process.env) {
  const enabled = environment.NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED?.trim().toLowerCase() === "true";
  const candidate = environment.NEXT_PUBLIC_DESKTOP_CLOUD_URL?.trim() || "https://chat.impractical.ai";
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("NEXT_PUBLIC_DESKTOP_CLOUD_URL must be an HTTPS origin.");
  }
  return { enabled, origin: url.origin };
}
