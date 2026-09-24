# Preparing a source release

Original Impractical code uses Apache License 2.0, including commercial use.
Preserve LICENSE, NOTICE, THIRD_PARTY_NOTICES.md and opencut/LICENSE. Third-party
code retains its original license; the root license does not replace it.

See [release-validation.md](release-validation.md) for the checks run and their limits.

The public repository is [Openpod/impractical-video](https://github.com/Openpod/impractical-video).
It starts with a reviewed snapshot and fresh history. For subsequent releases,
work from a clone of that repository, keep its history, run the checks below,
and tag the validated commit. Never merge the private development repository's
history into the public repository. Copy and review individual source changes
when carrying work across from a private checkout.

## Release a clean snapshot

The development repository has historically tracked experiment outputs and
scratch files. Ignoring them does not remove them from Git history. Use the
explicit source exporter for the first public release instead of changing the
visibility of the development repository.

```bash
npm run check
npx playwright install chromium
npm run test:smoke
npm audit --audit-level=high
npm run release:scan
npm run release:source
```

The exporter copies an explicit set of current source files into
`dist/source/video-fs`. It includes uncommitted fixes but excludes `.git`, env
secrets, local projects, caches, experiments, scratch files and the unused
`opencut-classic` reference checkout. It rejects symlinks and common credential
patterns, and refuses to overwrite an existing export. Pass a new destination
with `npm run release:source -- /absolute/new/path` for another snapshot.

Verify the snapshot as a new contributor:

```bash
cd dist/source/video-fs
npm ci
npm run setup
npm run doctor
npm run check
npm run build
npm start
```

Review the exported files, initialize a new repository there, and publish it
only after the intended owner and destination are confirmed. If retaining the
original Git history instead, independently review every historical revision
and artifact for private material and redistribution rights first. The source
scanner does not audit history or establish ownership of assets.

## Desktop artifacts

Desktop builds default to local mode with cloud login disabled. Provider keys
are excluded from build environments; users enter their own fal.ai key in
**Account → API keys** when generation is needed. The repository supports a local unsigned
macOS build through `npm run desktop:dist:mac:unsigned`.

For public binaries, supply your own signing/notarization credentials and run
`npm run desktop:dist:mac`. See [desktop packaging](../desktop/README.md).
Cloud-enabled builds explicitly set `NEXT_PUBLIC_DESKTOP_CLOUD_ENABLED=true`
and `NEXT_PUBLIC_DESKTOP_CLOUD_URL` when building. The build records this public
configuration so the server and renderer use the same mode when packaged.

A source release does not establish a signed binary release or an update feed.
Paid generation must be validated with an authorized provider account; automated
checks use fixtures and do not consume generation credits.
