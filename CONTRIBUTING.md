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
