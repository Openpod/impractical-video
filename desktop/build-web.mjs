import { spawn } from "node:child_process";
import process from "node:process";
import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { desktopCloudConfiguration } from "./cloud-config.mjs";

const { loadEnvConfig } = nextEnv;
const { parsedEnv = {} } = loadEnvConfig(process.cwd());

const cloud = desktopCloudConfiguration();
const desktopCloudUrl = cloud.origin;
const parsedCloudUrl = new URL(desktopCloudUrl);
if (
  parsedCloudUrl.protocol !== "https:" ||
  parsedCloudUrl.pathname !== "/" ||
  parsedCloudUrl.search ||
  parsedCloudUrl.hash
) {
  throw new Error("NEXT_PUBLIC_DESKTOP_CLOUD_URL must be an HTTPS origin.");
}

// Next loads .env.local again inside the build child. Predefine every project
// variable as empty so dotenv cannot reintroduce an unrelated provider or
// deployment credential. Only the two explicitly public desktop values below
// are restored. Also remove secret-shaped ambient values inherited from a CI
// runner while preserving build essentials such as PATH, HOME, and TMPDIR.
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => {
    if (name.startsWith("NEXT_PUBLIC_")) return false;
    if (name.startsWith("APPLE_") || name.startsWith("CSC_")) return false;
    return !/(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|WEBHOOK)/i.test(name);
  }),
);
const clearedProjectEnvironment = Object.fromEntries(
  Object.keys(parsedEnv).map((name) => [name, ""]),
);

const desktopEnvironment = {
  ...inheritedEnvironment,
  ...clearedProjectEnvironment,
  APP_MODE: "local",
  CLERK_SECRET_KEY: "",
  FAL_KEY: "",
  NEXT_PUBLIC_APP_MODE: "local",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED: String(cloud.enabled),
  NEXT_PUBLIC_DESKTOP_CLOUD_URL:
    desktopCloudUrl,
  NEXT_PUBLIC_INTERCOM_APP_ID: "",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  OPENROUTER_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
};

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(command, ["run", "build"], {
  env: desktopEnvironment,
  stdio: "inherit",
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Desktop web build exited from signal ${signal}.`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
if (exitCode === 0) {
  await mkdir("desktop/generated", { recursive: true });
  await writeFile("desktop/generated/cloud-config.json", JSON.stringify(cloud));
}
