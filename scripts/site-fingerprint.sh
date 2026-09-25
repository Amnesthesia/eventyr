#!/usr/bin/env bash
# Fingerprints a built Astro site so structural refactors can prove the output is unchanged.
# Hashed bundles under _astro/ are excluded and references to them normalised, because
# moving a module changes its chunk hash without changing what the page renders.
# Build both sides on the same day: /today/ and /tomorrow/ pages depend on the build clock.
# Compare fingerprints made on the same OS: BSD and GNU sed differ on files without a final newline.
set -euo pipefail
# C locale: BSD sed rejects non-UTF-8 bytes (images, fonts) under a UTF-8 locale.
export LC_ALL=C
dist="${1:?usage: site-fingerprint.sh <dist-dir> <out-file>}"
out="${2:?usage: site-fingerprint.sh <dist-dir> <out-file>}"
# Absolute path without `realpath -m`, which macOS's realpath lacks.
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
cd "$dist"
find . -type f ! -path './_astro/*' -print0 | sort -z |
  while IFS= read -r -d '' f; do
    printf '%s  %s\n' "$(sed -E 's#/_astro/[A-Za-z0-9_.@-]+#/_astro/X#g' "$f" | sha256sum | cut -d' ' -f1)" "$f"
  done > "$out"
echo "$(wc -l < "$out" | tr -d ' ') files fingerprinted → $out"
