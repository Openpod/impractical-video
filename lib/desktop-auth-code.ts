import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const AUTHORIZATION_TTL_SECONDS = 120;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

type AuthEnvironment = Record<string, string | undefined>;

type AuthorizationPayload = {
  challenge: string;
  exp: number;
  iat: number;
  jti: string;
  kind: "authorization";
  sessionId: string;
  state: string;
  userId: string;
};

type RefreshPayload = {
  exp: number;
  iat: number;
  jti: string;
  kind: "refresh";
  sessionId: string;
  userId: string;
};

type UnverifiedPayload = {
  challenge?: unknown;
  exp?: unknown;
  iat?: unknown;
  jti?: unknown;
  kind?: unknown;
  sessionId?: unknown;
  state?: unknown;
  userId?: unknown;
};

function secret(environment: AuthEnvironment): string {
  const value = environment.INTERNAL_API_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("Desktop auth is not configured.");
  }
  return value;
}

function assertTokenPart(value: unknown, name: string, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw new Error(`Invalid desktop auth ${name}.`);
  }
  return value;
}

export function assertDesktopAuthState(value: unknown): string {
  return assertTokenPart(value, "state", 32, 128);
}

export function assertDesktopPkceChallenge(value: unknown): string {
  return assertTokenPart(value, "challenge", 43, 128);
}

export function assertDesktopPkceVerifier(value: unknown): string {
  return assertTokenPart(value, "verifier", 43, 128);
}

export function desktopPkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(assertDesktopPkceVerifier(verifier))
    .digest("base64url");
}

function sign(payload: AuthorizationPayload | RefreshPayload, environment: AuthEnvironment): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret(environment)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verify(
  code: unknown,
  expectedKind: AuthorizationPayload["kind"] | RefreshPayload["kind"],
  environment: AuthEnvironment,
  nowSeconds: number,
): AuthorizationPayload | RefreshPayload {
  if (typeof code !== "string" || code.length > 4096) throw new Error("Invalid desktop auth code.");
  const [encoded, providedSignature, extra] = code.split(".");
  if (!encoded || !providedSignature || extra) throw new Error("Invalid desktop auth code.");
  const expectedSignature = createHmac("sha256", secret(environment)).update(encoded).digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(providedSignature, "base64url");
  } catch {
    throw new Error("Invalid desktop auth code.");
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("Invalid desktop auth code.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid desktop auth code.");
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid desktop auth code.");
  const value = payload as UnverifiedPayload;
  if (
    value.kind !== expectedKind ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number" ||
    value.iat > nowSeconds + 30 ||
    value.exp <= nowSeconds ||
    value.exp - value.iat > (expectedKind === "authorization" ? AUTHORIZATION_TTL_SECONDS : REFRESH_TTL_SECONDS)
  ) {
    throw new Error("Desktop auth code has expired.");
  }
  assertTokenPart(value.jti, "id", 16, 128);
  assertTokenPart(value.userId, "user", 6, 256);
  assertTokenPart(value.sessionId, "session", 6, 256);
  if (expectedKind === "authorization") {
    assertDesktopAuthState(value.state);
    assertDesktopPkceChallenge(value.challenge);
  }
  return value as AuthorizationPayload | RefreshPayload;
}

export function createDesktopAuthorizationCode(
  input: { challenge: string; sessionId: string; state: string; userId: string },
  environment: AuthEnvironment = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return sign(
    {
      challenge: assertDesktopPkceChallenge(input.challenge),
      exp: nowSeconds + AUTHORIZATION_TTL_SECONDS,
      iat: nowSeconds,
      jti: randomBytes(18).toString("base64url"),
      kind: "authorization",
      sessionId: assertTokenPart(input.sessionId, "session", 6, 256),
      state: assertDesktopAuthState(input.state),
      userId: assertTokenPart(input.userId, "user", 6, 256),
    },
    environment,
  );
}

export function verifyDesktopAuthorizationCode(
  code: unknown,
  verifier: unknown,
  environment: AuthEnvironment = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthorizationPayload {
  const payload = verify(code, "authorization", environment, nowSeconds) as AuthorizationPayload;
  if (desktopPkceChallenge(assertDesktopPkceVerifier(verifier)) !== payload.challenge) {
    throw new Error("Desktop auth verifier does not match.");
  }
  return payload;
}

export function createDesktopRefreshCode(
  input: { sessionId: string; userId: string },
  environment: AuthEnvironment = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return sign(
    {
      exp: nowSeconds + REFRESH_TTL_SECONDS,
      iat: nowSeconds,
      jti: randomBytes(18).toString("base64url"),
      kind: "refresh",
      sessionId: assertTokenPart(input.sessionId, "session", 6, 256),
      userId: assertTokenPart(input.userId, "user", 6, 256),
    },
    environment,
  );
}

export function verifyDesktopRefreshCode(
  code: unknown,
  environment: AuthEnvironment = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): RefreshPayload {
  return verify(code, "refresh", environment, nowSeconds) as RefreshPayload;
}
