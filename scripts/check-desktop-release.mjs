import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import nextEnv from "@next/env";
import { desktopCloudConfiguration } from "../desktop/cloud-config.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const failures = [];
const value = (name) => process.env[name]?.trim() || "";

let cloudOrigin = "https://chat.impractical.ai";
try {
  const cloudUrl = new URL(
    value("NEXT_PUBLIC_DESKTOP_CLOUD_URL") ||
      "https://chat.impractical.ai",
  );
  if (cloudUrl.protocol !== "https:" || cloudUrl.pathname !== "/" || cloudUrl.search || cloudUrl.hash) {
    failures.push("the desktop cloud URL must be an HTTPS origin");
  }
  cloudOrigin = cloudUrl.origin;
} catch {
  failures.push("the desktop cloud URL is invalid");
}

let hostedDesktopAuthAvailable = false;
if (desktopCloudConfiguration().enabled && failures.length === 0) {
  try {
    const response = await fetch(`${cloudOrigin}/desktop-auth`, { redirect: "follow" });
    hostedDesktopAuthAvailable = response.ok;
  } catch {
    // Report the actionable release configuration error below.
  }
}
if (desktopCloudConfiguration().enabled && !hostedDesktopAuthAvailable) {
  failures.push("the hosted desktop authentication handoff is unavailable");
}

if (!existsSync("desktop/build/icon.icns")) {
  failures.push("desktop/build/icon.icns is missing");
}

let installedIdentities = "";
try {
  installedIdentities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  // The explicit CSC certificate path below remains valid in isolated CI.
}
const hasDeveloperId = /Developer ID Application:/i.test(installedIdentities);
const hasCscCertificate = Boolean(value("CSC_LINK"));
if (!hasDeveloperId && !hasCscCertificate) {
  failures.push("a Developer ID Application certificate (installed or CSC_LINK) is missing");
}

const hasApiNotary = Boolean(
  value("APPLE_API_KEY") && value("APPLE_API_KEY_ID") && value("APPLE_API_ISSUER"),
);
const hasAppleIdNotary = Boolean(
  value("APPLE_ID") && value("APPLE_APP_SPECIFIC_PASSWORD") && value("APPLE_TEAM_ID"),
);
const hasKeychainNotary = Boolean(value("APPLE_KEYCHAIN") && value("APPLE_KEYCHAIN_PROFILE"));
if (!hasApiNotary && !hasAppleIdNotary && !hasKeychainNotary) {
  failures.push("Apple notarization credentials are missing");
}

if (failures.length) {
  console.error("Desktop public release is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Desktop signing and notarization configuration is ready.");
}
