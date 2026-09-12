# Gaming components

The lwfa Gaming panel installs optional per-user components and keeps settings
for each installed Steam game. Gaming settings require Python 3.11 or newer.
Installing the original GE archive also requires Python's tar extraction
filters, included in updated Python 3.11 releases and Python 3.12 or newer.

The `lwfa-game %command%` Steam launch option applies the selected game profile
only inside lwfa. Host launches pass through without applying it. Component
installation does not change Steam's game selections or restart Steam.

Proton installation uses a packaged Canvas artifact when available. Otherwise,
`proton.py` downloads the pinned lwfa 1.5.8 release, verifies its digest, reads
only its Canvas artifact as archive data, and validates the portable payload.
It never executes the downloaded installer. Matching Wine sources are published
with that release. The original GE runtime is separately downloaded from its
pinned official release; users do not need a separate manual GE installation.

For an offline package, set `LWFA_GE_BASE_ARCHIVE` to the original verified
`GE-Proton11-6-x86_64.tar.gz` when running either package script. The packager
also obtains the matching Canvas artifact unless `LWFA_WINE_CANVAS_ARTIFACT`
already specifies one. Both archives are checked before they are packaged.
Ordinary packages include the managers and obtain components only on request.

Installed LSFG and Framegen components retain their upstream notices and
provenance beside their binaries. Lossless.dll is obtained from the user's own
Steam installation and is not distributed by lwfa. The helper code's license
is included as `LICENSE` in packaged installations.
