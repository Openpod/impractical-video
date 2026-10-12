# Contributing

Impractical welcomes bug reports, fixes, examples, and improvements.
Original code is licensed under the [Apache License 2.0](LICENSE).
Contributions are accepted under the same license; retain upstream notices
when modifying third-party code. Contribute only code you have the right to
license. No copyright assignment is required.

1. Install Node.js 22.13+ and Git, then run `npm ci` and `npm run setup`.
2. Run `npm run doctor` and start `npm run dev` or `npm run desktop:dev`.
3. Make a focused change and add regression coverage for changed behavior.
4. Run `npm run check`. For UI/setup changes, run `npx playwright install chromium`
   followed by `npm run test:smoke`.
5. Explain the problem, resulting behavior, and validation in your pull request.

Never commit `.env.local`, API keys, local projects, provider outputs, screenshots
of private projects, or generated builds. Tests must use temporary projects and
mock paid providers. The browser smoke suite creates its own temporary data root
and does not call paid APIs.

The source is organized into `app/` (Next routes and UI), `lib/` (workspace and
generation logic), `desktop/` (Electron and agent integration), `opencut/`
(vendored editor), and `tests/` (behavior and integration tests). Local files
are the persistence boundary; hosted Clerk/Supabase/Stripe services are optional.

Be respectful, assume good intent, and keep feedback specific to the work.
Report security issues through the private channel described in [SECURITY.md](SECURITY.md).

## Maintenance and merges

Merge through a pull request after the GitHub Actions `verify` check passes on
an up-to-date branch. Review the diff and test evidence even for dependency PRs;
CI passing does not replace review. Keep fixes focused and preserve contributor
attribution when merging. Do not bypass failing checks to merge a contribution.

CI runs for pull requests, pushes to `main`, release tags, and every Monday at
09:23 UTC. It can also be started manually from Actions. The weekly run detects
new advisories even when the source has not changed. Dependabot checks npm and
GitHub Actions weekly and proposes updates as PRs; updates are not auto-merged.

For dependency updates, run `npm run audit:check` as well as `npm run check`.
Keep Next and its ESLint config compatible. When updating Electron, update
`desktop/package.json`'s `build.electronVersion` to match the tested root
lockfile so packaged apps receive the same fixes. Review the temporary exception
in [SECURITY.md](SECURITY.md) before its expiry and remove it when an upstream
patch is available. Test the browser, production build, and source export before
merging runtime or packaging dependency changes.
