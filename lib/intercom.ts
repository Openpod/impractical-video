export const DEFAULT_INTERCOM_API_BASE = "https://api-iam.intercom.io";

export type IntercomUser = {
  createdAt?: Date | null;
  email?: string | null;
  name?: string | null;
  userId: string;
};

export type IntercomSettings = {
  api_base: string;
  app_id: string;
  created_at?: number;
  email?: string;
  hide_default_launcher: boolean;
  name?: string;
  user_id: string;
};

export function getIntercomAppId() {
  const value = process.env.NEXT_PUBLIC_INTERCOM_APP_ID?.trim();
  return value ? value : null;
}

export function getIntercomApiBase() {
  const value = process.env.NEXT_PUBLIC_INTERCOM_API_BASE?.trim();
  return value ? value : DEFAULT_INTERCOM_API_BASE;
}

export function buildIntercomSettings(appId: string, user: IntercomUser): IntercomSettings {
  const settings: IntercomSettings = {
    app_id: appId,
    api_base: getIntercomApiBase(),
    hide_default_launcher: true,
    user_id: user.userId,
  };

  if (user.email) {
    settings.email = user.email;
  }

  if (user.name) {
    settings.name = user.name;
  }

  if (user.createdAt instanceof Date && !Number.isNaN(user.createdAt.getTime())) {
    settings.created_at = Math.floor(user.createdAt.getTime() / 1000);
  }

  return settings;
}
