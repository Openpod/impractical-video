# Local development

Run `npm ci`, `npm run setup`, and `npm run doctor`. The checked-in `.env.example`
is the local configuration. `.env.local.example` describes the optional hosted
configuration. Never replace a working `.env.local` without reviewing its values.

Keep `APP_MODE` and `NEXT_PUBLIC_APP_MODE` equal. Local mode needs no hosted
account and persists to the filesystem. Desktop users can explicitly opt into
Impractical credits in onboarding. Public flags are compiled into production
builds: rebuild after changing them. The generation choice is a runtime setting.

`npm run dev` and `npm start` bind to localhost. The desktop wrapper manages its
own server on ports 3210–3220. Run one development surface at a time because
both use the same Next build directory. `VIDEO_FS_APP_URL` must match your web
server port for MCP connections. Desktop manages its own connection URL.

## Agents

Install and authenticate Claude Code or Codex before using the agent prompt
box. `VIDEO_FS_COMPOSER_CLI` can select an absolute executable path. The CLI uses
its own authenticated account. The app's provider keys are not agent credentials.
Setup checks both installations without sending a prompt. Finder-launched
Desktop also searches the standard native, Homebrew, npm and Volta locations.
Claude powers the in-app companion; Claude and Codex both support the project
terminal. Use **Account → Setup guide** to recheck or connect them.

In desktop mode, opening a project creates project-scoped MCP and prompt hooks.
In web mode, run `npm run paper:setup -- <id>`. This command uses the same setup
implementation and preserves existing configuration. Start the CLI from the
project directory and complete its native trust steps. Generated configuration
reads the app credential at runtime; do not paste tokens into project files.

## API key storage

In local mode, use **Account → API keys** to save, replace, or remove your fal.ai
key without restarting. Create a key with **API** scope at
[fal.ai/dashboard/keys](https://fal.ai/dashboard/keys). The dialog saves the key;
it does not verify it or spend credits. Your next generation checks access with
fal.ai and uses your account's balance.

Saved credentials take priority over `FAL_KEY` in the process environment.
Removing the saved key restores that environment value, if present. Updating
`.env.local` requires a restart. Hosted deployments continue to use `FAL_KEY`
on the server; they cannot access the local settings API.

In development the file is `data/settings/providers.json`, or `settings/`
beside a custom `VIDEO_FS_DATA_ROOT`. Packaged desktop uses `settings/` in
Electron's user-data directory, so application upgrades retain the key. An
absolute `VIDEO_FS_SETTINGS_ROOT` can override the directory; keep it outside
project and shared directories.

The file is plain JSON, written atomically with owner-only permissions on
macOS/Linux (directory `0700`, file `0600`). It is not keychain-encrypted;
anyone with access to your OS account can read it. Keys are excluded from
source exports and desktop bundles, never included in project files or browser
storage, and never returned by the settings API. Keep private backups private.

## Onboarding and Impractical credits

The first-run setup covers the workspace, agents, generation and a first project.
Choose **I've got a fal API key**, **Purchase credits**, or **Skip** on the billing
step. Skipping leaves local uploads and editing available; video generation
requires a funded key or a positive Video FS credit balance.

In Desktop, Purchase credits opens the existing Impractical sign-in and checkout.
It uses `NEXT_PUBLIC_DESKTOP_CLOUD_URL` (default `https://chat.impractical.ai`).
The local browser workspace supports a fal.ai key; desktop account sign-in
requires Desktop's loopback callback and encrypted session store. Hosted web
deployments use their normal signed-in checkout.

The selection persists in `generation-mode.json` beside the API settings.
Saving a fal.ai key switches generation back to your own account immediately.
Choosing credits routes generation through Impractical and shows its balance in
the Account menu. Merely opening setup does not start sign-in, buy credits,
install an agent, or send any generation requests.

## Troubleshooting

- **Sign-in screen on a local install:** compare `.env.local` with `.env.example`.
  Set both mode flags to `local` and `NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED=false`.
  Restart dev or rebuild production.
- **Missing generation key:** open **Account → API keys**, save your fal.ai key,
  and retry. No restart is needed.
- **fal.ai rejected the key or model access:** replace a revoked/incorrect key;
  copy the complete key without quotes. Check its account and model permissions
  in the fal.ai dashboard.
- **Insufficient fal.ai balance:** add credits to the fal.ai account that owns
  the key. In BYOK mode, Impractical credits do not fund that account. To switch
  billing providers, revisit the setup guide and choose Purchase credits.
- **Could not read API settings:** replace or remove the saved key in the
  dialog. If saving fails, check write access to the settings directory.
- **MCP unauthorized:** run setup, ensure `PAPER_MCP_TOKEN` is at least 32 random
  characters, and keep `VIDEO_FS_REQUIRE_PROJECT_BINDING=true`. The data root
  must be absolute. Re-run `paper:setup` for the project.
- **CLI unavailable:** reopen the setup guide to recheck installation. For
  custom locations, include the executable in the launching shell's PATH or
  set `VIDEO_FS_COMPOSER_CLI` (project prompts) / `VIDEO_FS_COMPANION_CLI`
  (Claude companion) to its absolute path. Run `npm run doctor` for diagnostics.
- **Missing ffmpeg:** install FFmpeg, including ffprobe, and restart from a shell
  that has both on PATH.
- **Build directory locked:** stop the other local Next/Electron process before
  starting another build or smoke suite.

## Optional hosted deployment

Use `.env.local.example` as the configuration reference and explicitly select
hosted mode. Configure your own Clerk instance, Supabase project/storage and
Stripe webhook. The SQL definitions are under `database/`; review and apply
schema, billing, library, published-item and RLS definitions for the features
you enable. These scripts are not an automatic migration runner.

`npm run release:env` validates hosted deployment variables supplied through the
process environment. It intentionally does not load a developer's env file.
Trigger.dev, AWS FFmpeg and Modal tracking are separate optional deployments.
The hosted stack is not part of the credential-free local quickstart.
