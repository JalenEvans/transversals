#!/usr/bin/env bash
# Builds an unsigned, Apple Silicon-only macOS installer package:
#   out/transversals-<version>.pkg  (identifier io.github.jalenevans.transversals)
#
# Payload (installed to /usr/local/lib/transversals):
#   package.json, dist/*.js, dist/guest/win-arm64/* (Transversals.GuestAgent.exe
#   plus its native WPF DLLs),
#   production node_modules, and a bundled Node 22 at node/bin/node.
# The postinstall script only writes the /usr/local/bin/transversals wrapper;
# per-user setup is left to `transversals setup`, run by the user.
#
# This script never installs anything and writes only inside the repo and a
# mktemp staging directory. Production dependencies come from the npm cache
# (--offline); if the cache cannot satisfy them, the build stops.
set -euo pipefail

# Keep copyfile-based tools (pkgbuild's archiver, tar) from emitting AppleDouble ._* files.
export COPYFILE_DISABLE=1

readonly IDENTIFIER="io.github.jalenevans.transversals"
readonly INSTALL_LOCATION="/usr/local/lib/transversals"
readonly AGENT_EXE="Transversals.GuestAgent.exe"
readonly GUEST_DIR="dist/guest/win-arm64"
# Native WPF libraries published next to the exe (not embedded for self-extraction).
readonly AGENT_NATIVE_DLLS=(wpfgfx_cor3.dll PresentationNative_cor3.dll vcruntime140_cor3.dll PenImc_cor3.dll)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "build-pkg: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "must run on macOS (needs pkgbuild)."
command -v pkgbuild >/dev/null || fail "pkgbuild not found."

VERSION="$(node -p 'require("./package.json").version')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || fail "unexpected package.json version \"$VERSION\"."

# --- Bundled Node: the local arm64 Node 22 binary ----------------------------
NODE_BIN="$(command -v node)" || fail "node not found on PATH."
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
# Resolve symlink chains (Homebrew, nvm shims) to the real binary.
while [[ -L "$NODE_BIN" ]]; do
  target="$(readlink "$NODE_BIN")"
  [[ "$target" == /* ]] || target="$(dirname "$NODE_BIN")/$target"
  NODE_BIN="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
done
NODE_FILE="$(file -b "$NODE_BIN")"
[[ "$NODE_FILE" == *"Mach-O"* && "$NODE_FILE" == *arm64* ]] || fail "$NODE_BIN is not an arm64 Mach-O binary: $NODE_FILE"
NODE_VERSION="$("$NODE_BIN" -v)"
[[ "$NODE_VERSION" == v22.* ]] || fail "$NODE_BIN is $NODE_VERSION; Node 22.x is required."

NODE_PREFIX="$(cd "$(dirname "$NODE_BIN")/.." && pwd -P)"
NODE_LICENSE=""
for candidate in "$NODE_PREFIX/LICENSE" "$NODE_PREFIX/share/doc/node/LICENSE"; do
  if [[ -f "$candidate" ]]; then
    NODE_LICENSE="$candidate"
    break
  fi
done

echo "build-pkg: transversals $VERSION, bundling node $NODE_VERSION from $NODE_BIN"

# --- Build host and guest ---------------------------------------------------
npm run build
npm run guest:publish

for file in "$AGENT_EXE" "${AGENT_NATIVE_DLLS[@]}"; do
  [[ -f "$GUEST_DIR/$file" ]] || fail "$GUEST_DIR/$file missing after guest:publish."
done

# --- Stage ------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/transversals-pkg.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STAGE="$WORK/root"
SCRIPTS="$WORK/scripts"
mkdir -p "$STAGE/dist/guest/win-arm64" "$STAGE/node/bin" "$SCRIPTS"

cp package.json "$STAGE/package.json"

# Only the compiled modules for current sources (skips stale outputs, .d.ts, maps).
for source in src/*.ts; do
  name="$(basename "$source" .ts)"
  [[ -f "dist/$name.js" ]] || fail "dist/$name.js missing after build."
  cp "dist/$name.js" "$STAGE/dist/$name.js"
done
chmod 755 "$STAGE/dist/cli.js"

# The self-contained agent exe plus the native DLLs it loads from its own directory.
# guest:publish clears $GUEST_DIR first, so everything in it is current output.
cp -R "$GUEST_DIR/." "$STAGE/$GUEST_DIR/"

cp "$NODE_BIN" "$STAGE/node/bin/node"
chmod 755 "$STAGE/node/bin/node"
if [[ -n "$NODE_LICENSE" ]]; then
  cp "$NODE_LICENSE" "$STAGE/node/LICENSE"
else
  echo "build-pkg: warning: no Node LICENSE found under $NODE_PREFIX; shipping without it." >&2
fi

# Production dependencies from the local npm cache only; never the network.
cp package-lock.json "$STAGE/package-lock.json"
(
  cd "$STAGE"
  npm_config_logs_max=0 npm ci --omit=dev --offline --ignore-scripts \
    --no-audit --no-fund --no-update-notifier
) || fail "offline install of production dependencies failed (npm cache incomplete?). Not fetching from the network."
rm -f "$STAGE/package-lock.json" "$STAGE/node_modules/.package-lock.json"

find "$STAGE" -name .DS_Store -delete

# Clear xattrs (SIP-protected com.apple.provenance stays; Installer reapplies its ._* entries as xattrs).
xattr -cr "$STAGE"

# --- Installer scripts ------------------------------------------------------
cat >"$SCRIPTS/postinstall" <<'POSTINSTALL'
#!/bin/sh
# Writes the transversals command wrapper. Per-user setup is not run here.
set -e
mkdir -p /usr/local/bin
cat >/usr/local/bin/transversals <<'WRAPPER'
#!/bin/sh
exec /usr/local/lib/transversals/node/bin/node /usr/local/lib/transversals/dist/cli.js "$@"
WRAPPER
chmod 755 /usr/local/bin/transversals
echo "Installed /usr/local/bin/transversals. Run \`transversals setup\` to finish."
exit 0
POSTINSTALL
chmod 755 "$SCRIPTS/postinstall"

# --- Package ----------------------------------------------------------------
mkdir -p out
OUTPUT="out/transversals-$VERSION.pkg"
rm -f "$OUTPUT"
pkgbuild \
  --root "$STAGE" \
  --install-location "$INSTALL_LOCATION" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPTS" \
  --ownership recommended \
  "$OUTPUT"

echo "build-pkg: wrote $OUTPUT ($(du -h "$OUTPUT" | cut -f1 | tr -d ' '))"
