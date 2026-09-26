# API routes

These routes serve both the local workspace and optional hosted deployment.
Read `lib/app-mode.ts`, `middleware.ts`, and `SECURITY.md` before changing
access control or file and credential handling.

- Local mode is enabled only by explicit `APP_MODE=local`. Do not infer it from
  missing hosted credentials, file availability, or `NODE_ENV`. Keep local
  requests limited to loopback and reject cross-origin browser writes.
- Middleware does not authenticate every hosted route. Check the caller and
  resource ownership in routes that read or mutate private data; preserve the
  route's existing local and hosted behavior.
- Validate project IDs and confine filesystem access to the resolved project
  root. When `VIDEO_FS_REQUIRE_PROJECT_BINDING=true`, preserve the agent tool
  endpoint's project-bound bearer check so one project's token cannot access
  another project.
- Do not return provider keys, desktop bearer tokens, or private connection
  state in API responses. Settings endpoints should expose status only.
- Add focused tests for changed access rules in both local and hosted modes.
  Use temporary data roots and mock paid providers. Relevant examples include
  `tests/local-mode.test.ts`, `tests/paper-project-binding.test.ts`, and
  `tests/local-provider-settings.test.ts`.
