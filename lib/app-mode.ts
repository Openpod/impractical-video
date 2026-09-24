/**
 * The desktop/local boundary is deliberately explicit. Filesystem storage,
 * NODE_ENV, or missing hosted credentials must never silently disable auth or
 * billing in a cloud deployment.
 */
export const LOCAL_APP_MODE = "local";
export const LOCAL_APP_USER_ID = "local-desktop-user";

type AppModeEnvironment = Record<string, string | undefined>;

export function isLocalAppMode(
  environment: AppModeEnvironment = process.env,
): boolean {
  return environment.APP_MODE?.trim().toLowerCase() === LOCAL_APP_MODE;
}

export function isLocalAppModeClient(
  environment?: AppModeEnvironment,
): boolean {
  // Keep the default access statically addressable so Next can inline this
  // public value into the browser bundle.
  const value = environment
    ? environment.NEXT_PUBLIC_APP_MODE
    : process.env.NEXT_PUBLIC_APP_MODE;
  return (
    value?.trim().toLowerCase() === LOCAL_APP_MODE
  );
}

export function isBillingUiEnabled(
  environment?: AppModeEnvironment,
): boolean {
  const local = isLocalAppModeClient(environment);
  const desktopCloudEnabled = environment
    ? environment.NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED
    : process.env.NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED;
  return !local || desktopCloudEnabled?.trim().toLowerCase() === "true";
}
