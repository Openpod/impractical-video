const REQUIRED_HOSTED_ENV = [
  "CLERK_SECRET_KEY",
  "FAL_KEY",
  "INTERNAL_API_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "OPENROUTER_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function keyMode(value) {
  if (value?.startsWith("sk_live_") || value?.startsWith("pk_live_")) return "live";
  if (value?.startsWith("sk_test_") || value?.startsWith("pk_test_")) return "test";
  return null;
}

const failures = [];
for (const name of REQUIRED_HOSTED_ENV) {
  if (!process.env[name]?.trim()) failures.push(`${name} is missing`);
}

try {
  const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || "");
  if (appUrl.protocol !== "https:") failures.push("NEXT_PUBLIC_APP_URL must use HTTPS");
  if (appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1") {
    failures.push("NEXT_PUBLIC_APP_URL must be the deployed origin, not loopback");
  }
  if (appUrl.pathname !== "/" || appUrl.search || appUrl.hash) {
    failures.push("NEXT_PUBLIC_APP_URL must contain only the deployed origin");
  }
} catch {
  failures.push("NEXT_PUBLIC_APP_URL is not a valid absolute URL");
}

const secretMode = keyMode(process.env.STRIPE_SECRET_KEY);
const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
const publishableMode = keyMode(publishable);
if (publishable && secretMode && publishableMode && secretMode !== publishableMode) {
  failures.push("Stripe secret and publishable keys use different test/live modes");
}
if (!process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
  failures.push("STRIPE_WEBHOOK_SECRET is not a Stripe endpoint signing secret");
}

if (failures.length) {
  console.error("Hosted release configuration is not ready:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Hosted release configuration is ready.");
  console.log(
    `Stripe webhook target: ${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/webhooks/stripe`,
  );
}
