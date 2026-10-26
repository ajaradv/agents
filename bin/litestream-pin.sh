#!/usr/bin/env bash
# litestream-pin - install the pinned Litestream binary (checksum-verified).
# Linux and macOS. bin/hub-install runs this; on a Mac: bin/hub-install --litestream.
# Safe to run again: a binary that is already this version is left in place.
#
# The release tarballs are hashed below. Re-pin every line when the version moves.
# v0.5.17 asset names use x86_64 (not amd64). Checked against the release
# checksums.txt and a local sha256sum of each tarball.
set -euo pipefail

LITESTREAM_VERSION=0.5.17
# sha256  asset
LITESTREAM_LINUX_X86_64_SHA=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
LITESTREAM_LINUX_ARM64_SHA=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5
LITESTREAM_DARWIN_ARM64_SHA=e211f68ff7658d19f193f2914417afdf8f89a053ff8f263e5d6b3b1d3bbc7b08
LITESTREAM_DARWIN_X86_64_SHA=891875af09db152e93a4b31a8a79f538ce7ce702c132803cfe0a831e7cb1b7db

die() { printf 'error: %s\n' "$1" >&2; exit "${2:-1}"; }

case "$(uname)-$(uname -m)" in
  Linux-x86_64) ASSET="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; SHA="$LITESTREAM_LINUX_X86_64_SHA" ;;
  Linux-aarch64|Linux-arm64) ASSET="litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz"; SHA="$LITESTREAM_LINUX_ARM64_SHA" ;;
  Darwin-arm64) ASSET="litestream-${LITESTREAM_VERSION}-darwin-arm64.tar.gz"; SHA="$LITESTREAM_DARWIN_ARM64_SHA" ;;
  Darwin-x86_64) ASSET="litestream-${LITESTREAM_VERSION}-darwin-x86_64.tar.gz"; SHA="$LITESTREAM_DARWIN_X86_64_SHA" ;;
  *) die "unsupported platform $(uname) $(uname -m)" 2 ;;
esac

BIN="${LITESTREAM_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
installed="$("$BIN/litestream" version 2>/dev/null | head -1 || true)"
if [ "$installed" = "$LITESTREAM_VERSION" ]; then
  echo "litestream $LITESTREAM_VERSION already installed ($BIN/litestream)"
  exit 0
fi

url="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${ASSET}"
tmp="$(mktemp)"
work="$(mktemp -d)"
trap 'rm -rf "$tmp" "$work"' EXIT
curl -fsSL -o "$tmp" "$url" || die "could not download $url"
dir="$(dirname "$tmp")"
base="$(basename "$tmp")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dir" && echo "$SHA  $base" | sha256sum -c --quiet) || die "checksum mismatch for $ASSET"
else
  (cd "$dir" && echo "$SHA  $base" | shasum -a 256 -c --quiet) || die "checksum mismatch for $ASSET"
fi
tar -xzf "$tmp" -C "$work" litestream
install -m 0755 "$work/litestream" "$BIN/litestream"
echo "installed litestream $LITESTREAM_VERSION to $BIN/litestream"
