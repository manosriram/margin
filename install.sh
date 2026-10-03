#!/bin/sh
# Install margin from the latest GitHub release (Linux and macOS, amd64/arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/manosriram/margin/main/install.sh | sh
#
# Env: MARGIN_VERSION=v1.2 to pin a release, MARGIN_INSTALL_DIR=/some/bin to choose where it goes.
set -eu

repo="manosriram/margin"

err() { echo "install.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "needs $1"; }
need curl
need tar

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS $(uname -s); build from source with: go build -o margin ." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture $(uname -m)" ;;
esac

# Latest tag from the /releases/latest redirect, which (unlike the API) isn't rate limited.
version="${MARGIN_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  version=${version##*/}
  case "$version" in v*) ;; *) err "couldn't find the latest release" ;; esac
fi

asset="margin_${version}_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/download/$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading margin $version ($os/$arch)…"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || err "no build for $os/$arch in $version"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || err "couldn't download checksums"

want=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ -n "$want" ] && [ "$want" = "$got" ] || err "checksum mismatch for $asset"

tar -xzf "$tmp/$asset" -C "$tmp" margin

# /usr/local/bin if we can write there, else ~/.local/bin (no sudo needed).
dir="${MARGIN_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
install -m 755 "$tmp/margin" "$dir/margin"
echo "Installed $dir/margin"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH:  export PATH=\"$dir:\$PATH\"" ;;
esac
command -v claude >/dev/null 2>&1 || echo "margin needs Claude Code: https://claude.com/claude-code"
