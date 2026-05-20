#!/usr/bin/env bash
# Refresh the vendored Swagger UI distribution from a pinned GitHub release.
#
# Usage:
#   scripts/refresh-swagger-ui.sh                  # use VERSION file
#   scripts/refresh-swagger-ui.sh v5.33.0          # bump pin to this tag
#
# Refreshes the 6 vendored upstream files. Refuses to overwrite our patched
# index.html and swagger-initializer.js — those must be bumped by hand so any
# upstream changes to them are reviewed deliberately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/docs/swagger-ui"
VERSION_FILE="$VENDOR_DIR/VERSION"

NEW_VERSION="${1:-$(cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]')}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "no version supplied and $VERSION_FILE missing or empty" >&2
  exit 2
fi
if [[ "$NEW_VERSION" != v* ]]; then
  echo "version must look like v5.x.y (got: $NEW_VERSION)" >&2
  exit 2
fi

TARBALL_URL="https://github.com/swagger-api/swagger-ui/archive/refs/tags/${NEW_VERSION}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $TARBALL_URL"
curl -fsSL -o "$TMP/swagger-ui.tar.gz" "$TARBALL_URL"

echo "Extracting"
tar -xzf "$TMP/swagger-ui.tar.gz" -C "$TMP"
SRC="$TMP/swagger-ui-${NEW_VERSION#v}/dist"
LICENSE_SRC="$TMP/swagger-ui-${NEW_VERSION#v}/LICENSE"

if [[ ! -d "$SRC" ]]; then
  echo "expected $SRC after extract, but it's missing — release tarball layout may have changed" >&2
  exit 3
fi

mkdir -p "$VENDOR_DIR"

UPSTREAM_FILES=(
  swagger-ui.css
  swagger-ui-bundle.js
  swagger-ui-standalone-preset.js
  index.css
  favicon-16x16.png
  favicon-32x32.png
)
for f in "${UPSTREAM_FILES[@]}"; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "missing $f in upstream dist — refusing to vendor a partial set" >&2
    exit 4
  fi
  cp "$SRC/$f" "$VENDOR_DIR/$f"
  echo "  refreshed $f"
done

cp "$LICENSE_SRC" "$VENDOR_DIR/LICENSE"
echo "  refreshed LICENSE"

echo "$NEW_VERSION" > "$VENDOR_DIR/VERSION"

cat <<EOF

Done. Vendored Swagger UI is now $NEW_VERSION.

NOT touched by this script:
  - docs/swagger-ui/index.html             (patched: title, initializer load)
  - docs/swagger-ui/swagger-initializer.js (patched: spec URL, options)

If upstream changed either of those files (or shipped a new initializer
format), update them by hand and verify /docs still renders in a browser
before committing.

Air-gap guard (run before committing):
  grep -l https:// docs/swagger-ui/index.html docs/swagger-ui/swagger-initializer.js \\
    && { echo "found external URL — investigate" >&2; exit 1; } || echo "air-gap OK"
EOF
