# Release validation

Validated on macOS; clean release builds use Node.js 22.23.2. Updated 2026-09-23:

- Fresh source export: `npm ci` succeeds without credentials or pre-existing data.
- Setup creates a private local environment and preserves an existing file.
- TypeScript passes; ESLint has no errors (17 existing warnings remain).
- 441 Vitest tests pass across 61 files.
- All 47 desktop Node tests pass, including setup, auth, project isolation and hooks.
- Fifteen Chromium smoke tests pass: local creation/upload/persistence and editor
  navigation, local HTTP protection, the account-free OAuth callback, and
  saving/replacing/removing a fal.ai key through the UI across page reloads,
  onboarding completion/replay and first-project creation, API-key setup,
  credit sign-in, checkout recovery and balance retry; contextual project tours
  in browser and desktop, project-tab closure across reloads, and local Library
  uploads, previews, playback, downloads, imports, rename/delete, drag-and-drop,
  partial failures and a 12 MB multipart upload. Hosted responses are
  mocked in browser tests; no purchases or live sign-ins are made.
- The live local Explore page loads the canonical Impractical catalog, including
  130 reference examples (50 characters), independently of credit mode.
- Library uploads stay outside project directories with private file permissions.
  Tests cover duplicate filenames, batch rollback, invalid byte ranges, active
  content downloads, hosted isolation, and preserving project copies after
  removing a Library upload.
- The running desktop detects both locally installed, signed-in Claude Code
  and Codex. Capability discovery no longer sends model-probing prompts.
- API-key regression tests cover private file permissions, credential precedence,
  immediate rotation, hosted isolation, request-origin checks, credential
  redaction, and actionable authentication/balance errors. Mocked fal clients
  verify credentials for image, video, audio, and storage; no credits are spent.
- A clean production build succeeds without Clerk, Supabase, Stripe or fal keys.
- A live production MCP client can read project status and workflows; it rejects
  attempts to access another project.
- Desktop web build, MCP bundle and standalone staging succeed. The staged
  runtime boots after relocation outside the repository, creates/reads/deletes
  projects, includes skills/workflows, and contains no dotenv files.
- The updated staged runtime also boots under Electron's embedded Node outside
  the repository. A saved fal key survives a full server-process restart; the
  production UI opens and removes it. The bundle contains no saved key files.
- `npm audit` reports zero known vulnerabilities for the resolved lockfile.
- The source export passes the credential/personal-path pattern scan.
- The initial public snapshot and its new Git history were also scanned with
  Gitleaks. The three reported matches were reviewed: two keyboard-shortcut
  attributes and one test idempotency key, all false positives.

Remaining build diagnostics include the Next middleware deprecation and broad
filesystem tracing warnings. These do not fail the build; runtime size still
needs further optimization before distributing desktop binaries.

This validation does not exercise paid provider generation, hosted billing,
Apple signing/notarization, auto-updates, Windows, or Linux desktop behavior.
The [Linux CI workflow](https://github.com/Openpod/impractical-video/actions/workflows/ci.yml)
reports its own results for every public commit. It provisions Electron's sandbox
helper and a virtual display for the installed-hook test.
The clean export contains no Git history; the original repository history has
not been cleared for public release. See [releasing.md](releasing.md).
