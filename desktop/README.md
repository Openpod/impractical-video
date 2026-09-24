# Impractical Desktop

Electron is a wrapper around the existing Next.js app. The standalone web app
continues to run with `npm run dev`; no UI or storage implementation is forked.

## Development

Run `npm ci` and `npm run setup` in the repository root first. Desktop defaults
to local mode without an account or hosted billing. Open **Account → API keys**
in the app and save your fal.ai key for generation. `FAL_KEY` in `.env.local`
is also supported. Install FFmpeg for local media processing.

```bash
npm run desktop:dev
```

The Electron main process starts Next on loopback, opens it in a sandboxed
`BrowserWindow`, and stops the server on quit. In development it reads and
writes the repository's `data/projects` directory. Override the location with
`VIDEO_FS_DATA_ROOT`.

To start the bundled stdio MCP bridge while the desktop app is open:

```bash
npm run desktop:mcp -- --project-id <project-id>
```

Opening a project in the desktop app automatically creates token-free
project-scoped configuration for both supported terminal agents:

- Claude Code: `.mcp.json`
- Codex CLI: `.codex/config.toml`

For the user-facing flow, follow the
[local development guide](../docs/local-development.md).

Open a terminal in that project directory and run `claude` or `codex`. Claude
asks for one-time approval of the project MCP server and generated project
hook. Impractical initializes a local Git worktree—with no commit or remote—so
Codex discovers the project configuration without flags. Codex requires its
native one-time project trust, followed by review and approval of the generated
Impractical hook through `/hooks`.

`.video-fs/CONNECT_AGENTS.md` contains conflict-specific recovery instructions
when Impractical preserves an existing agent configuration.

Setup never overwrites an existing `.mcp.json`, `.codex/config.toml`,
`CLAUDE.md`, or `AGENTS.md`. When a conflict exists, the original is preserved
byte-for-byte and the proposed configuration plus explicit fallback commands
are written under `.video-fs/`.

For development, setup can also be requested explicitly from the current
mode-0600 desktop connection record:

```bash
npm run desktop:setup -- <project-id>
```

The bridge discovers the current URL and per-launch bearer token from a
mode-0600 record in Electron's application-support directory. A packaged app
uses the same entry point:

```bash
"/Applications/Video FS.app/Contents/MacOS/Video FS" --mcp \
  --project-id <project-id>
```

The packaged app ships the setup helper in the same stable executable:

```bash
"/Applications/Video FS.app/Contents/MacOS/Video FS" --setup-agent \
  --project-id <project-id>
```

Neither generated configuration contains the bearer token. Both entry points
read the current private desktop connection record at runtime and provide an
actionable open/reconnect message when the app is unavailable.

The packaged server binds only to `127.0.0.1` (development uses `localhost` to
match Next's middleware proxy). If port 3210 is occupied, Electron selects a
free loopback port and records the result for the MCP bridge.

## macOS packaging and optional hosted credits

The packaged app keeps project files and MCP access on the user's machine.
Local builds need no hosted account. For generation, open **Account → API keys**
and save your fal.ai key. It takes effect immediately and persists across app
restarts and upgrades in the user-data settings directory. No Terminal setup
is needed. Packaged apps do not load the source checkout's `.env.local`.

Hosted credits are opt-in from **Account → Setup guide → Purchase credits**.
Users can sign in and use the existing Impractical checkout without rebuilding.
`NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED=true` sets the default generation choice;
`NEXT_PUBLIC_DESKTOP_CLOUD_URL` selects the hosted service at build time.
The user's saved choice takes precedence over the default, and saving a fal.ai
key switches generation back to BYOK. Hosted credit sessions use an encrypted
desktop session store and survive restarts. Provider, Stripe, Supabase and
Clerk secrets are never included in the desktop artifact.

`npm run desktop:dist:mac` first requires a Developer ID Application identity
and Apple notarization credentials, then builds Next's standalone server,
bundles the MCP stdio entry point, and creates signed/notarized DMG and ZIP
artifacts with electron-builder.
The ZIP is required for differential auto-updates; the DMG is the human install
path.

The desktop web build always compiles with `APP_MODE=local` and
`NEXT_PUBLIC_APP_MODE=local`. Only the explicit public cloud mode and hosted
cloud origin are retained. Supabase, Stripe, Intercom, OpenRouter, fal, and
Clerk server credentials are explicitly empty so developer secrets cannot
enter or change the desktop artifact.

For an internal Gatekeeper-bypassed artifact, use
`npm run desktop:dist:mac:unsigned`. It is a test build, not a public release.

Before a public build:

1. Sign with a Developer ID Application certificate in an isolated CI keychain.
2. Enable hardened runtime and sign nested Electron/Node helpers with
   `desktop/entitlements.mac.plist`.
3. Notarize using App Store Connect API credentials stored in CI, then staple
   the notarization ticket to the DMG.
4. Publish the DMG, ZIP, blockmaps, and update metadata to a versioned HTTPS
   release bucket. Add `electron-updater` only when that feed exists; check on
   launch, download in the background, and require an explicit user action to
   restart/install.
5. Generate separate arm64 and x64 artifacts first. A universal build is
   optional because it roughly doubles the bundled native payload.

The unsigned arm64 proof bundle measured about 387 MB after excluding local
eval/test artifacts and retaining only Next's traced runtime dependencies. Its
DMG was 143 MB and update ZIP 145 MB. Measure signed release artifacts again;
native media dependencies and future bundled ffmpeg binaries are the main
variance.

The release preflight accepts either App Store Connect API credentials,
Apple-ID credentials, or a notarytool keychain profile. Keep those founder-owned
values out of `.env.local` and supply them through an isolated release keychain
or CI secret store.
