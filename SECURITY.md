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

Run `npm run check`, `npm run test:smoke`, `npm audit`, and `npm run release:scan`.
The source scanner is a bounded check for common credential patterns, not a
proof that all information is public. Before changing the visibility of an
existing repository, review its complete Git history, issues and artifacts.
The source export intentionally contains no Git history or local experiments.
