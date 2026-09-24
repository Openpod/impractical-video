# Third-party notices

The root Apache License 2.0 covers original Impractical code. It does
not replace licenses on third-party code or assets or restrict rights already
granted by their copyright holders.

## OpenCut

The embedded editor under `opencut/` derives from
[OpenCut](https://github.com/OpenCut-app/OpenCut). Its MIT notice is reproduced
verbatim in [opencut/LICENSE](opencut/LICENSE). The effects preview, icons and
font preview atlas under `public/` were copied with the editor. Preserve this
notice when distributing those files. The development-only upstream checkout
at `opencut-classic/`, when present, has its own MIT license and is not needed
to run Impractical.

## Dependencies and external media

npm dependencies retain the license files distributed with their packages;
the lockfile records the resolved versions. Electron distributions must keep
Electron's Chromium and third-party notices. Do not strip license files from
the standalone server or Electron distribution.

Fonts, models, sound libraries, and media downloaded at runtime are governed
by their respective licenses and provider terms. User-supplied media is not
licensed by this repository. FFmpeg is installed separately and is not bundled
in the source release.
