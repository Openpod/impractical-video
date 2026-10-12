# Security

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/Openpod/impractical-video/security/advisories/new).
If private reporting is unavailable, open an issue asking for a private contact
without including exploit details, credentials, or private project data.

## Local trust boundary

Local mode is a single-user app bound to loopback. It can read/write project
files, invoke local agent CLIs, process media, and call providers using your
keys. Do not expose it through a public tunnel, reverse proxy, or shared host.
It is not a sandbox for untrusted projects or prompts. The agent composer can
run Claude Code with unattended permission settings; use a separate OS account
or container if you need isolation from other files on your machine.

MCP credentials belong in the private app environment or desktop connection
record. Generated project configurations contain no credentials and bind to
one project. The app rejects cross-origin browser writes in local mode.

Local fal.ai keys saved through **Account → API keys** are stored outside
projects in `settings/providers.json`, with owner-only file permissions on
macOS/Linux. This file is not encrypted with the OS keychain. It is excluded
from source exports and desktop bundles; the settings API returns only status.
See [storage details](docs/local-development.md#api-key-storage).

Hosted deployments need their own Clerk, Supabase, Stripe and provider setup.
They must keep `APP_MODE=hosted` and `NEXT_PUBLIC_APP_MODE=hosted`; missing
credentials must never silently switch a public deployment into local mode.

## Release checks

Run `npm run check`, `npm run test:smoke`, `npm run audit:check`, and `npm run release:scan`.
The source scanner is a bounded check for common credential patterns, not a
proof that all information is public. Before changing the visibility of an
existing repository, review its complete Git history, issues and artifacts.
The source export intentionally contains no Git history or local experiments.

## Temporary dependency audit exception

`npm run audit:check` checks the full npm dependency graph, including development
packages, and blocks high/critical advisories. Registry failures and malformed
reports also fail the check. Lower-severity findings remain visible in the totals;
use `npm audit` for the complete report.

Until **2026-11-10 (UTC)**, it accepts only
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
in `braces@3.0.3` and its reviewed lint-only chain (`micromatch@4.0.8`,
`fast-glob@3.3.1`, `@next/eslint-plugin-next@16.4.0`, and
`eslint-config-next@16.4.0`). There is no patched release as of 2026-10-11.
The vulnerable recursive brace parser receives repository-controlled lint glob
patterns; application users do not supply these patterns. Every accepted package
must remain marked development-only in the lockfile at its reviewed version.
New advisories, production usage, version changes, or expiry fail the check.
Remove the exception when a compatible upstream fix is available. Do not use
`npm audit fix --force`: its proposed Next lint downgrade is incompatible with
this application's Next version.

The moderate `sprintf-js` advisory in Electron's build-time download/proxy
logging chain has no patched release either. It is not exempted: it remains
below the existing high-severity blocking threshold. Review both upstream
advisories during dependency maintenance.
