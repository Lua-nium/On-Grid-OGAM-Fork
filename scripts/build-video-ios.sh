#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVISION="$(cat "$ROOT/scripts/video/revision")"
CACHE="${OFFGRID_VIDEO_BUILD_DIR:-$ROOT/.video-build}"
SOURCE="${OFFGRID_SD_SOURCE:-$CACHE/source}"
OUTPUT="$ROOT/native/video/OffgridVideoRuntime.xcframework"
BUILD_KEY="$(cat "$ROOT/scripts/video/revision" "$ROOT/scripts/video/exports.txt" "$ROOT/scripts/video/CMakeLists.txt" "$ROOT/scripts/video/conditioning-errors.patch" | shasum -a 256 | cut -d' ' -f1)"
if [ -f "$OUTPUT/ios-arm64/OffgridVideoRuntime.framework/Headers/stable-diffusion.h" ] && [ -f "$OUTPUT/revision" ] && [ "$(cat "$OUTPUT/revision")" = "$BUILD_KEY" ]; then exit 0; fi
mkdir -p "$CACHE"
if [ ! -d "$SOURCE/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/leejet/stable-diffusion.cpp.git "$SOURCE"
fi
if [ "$(git -C "$SOURCE" rev-parse HEAD)" != "$REVISION" ]; then
  git -C "$SOURCE" fetch origin "$REVISION"
  git -C "$SOURCE" checkout --detach "$REVISION"
fi
git -C "$SOURCE" submodule update --init --depth 1 ggml
PATCH="$ROOT/scripts/video/conditioning-errors.patch"
if ! git -C "$SOURCE" apply --reverse --check "$PATCH" 2>/dev/null; then
  git -C "$SOURCE" apply "$PATCH"
fi
for SDK in iphoneos iphonesimulator; do
  cmake -S "$ROOT/scripts/video" -B "$CACHE/$SDK" -G Xcode \
    -DSD_SOURCE="$SOURCE" -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$SDK" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=17.0
  cmake --build "$CACHE/$SDK" --config Release --target stable-diffusion -- -quiet CODE_SIGNING_ALLOWED=NO
 done
# Replace only this generated build artifact.
rm -rf "$OUTPUT"
xcodebuild -create-xcframework \
  -framework "$CACHE/iphoneos/bin/Release/OffgridVideoRuntime.framework" \
  -framework "$CACHE/iphonesimulator/bin/Release/OffgridVideoRuntime.framework" \
  -output "$OUTPUT"
printf '%s\n' "$BUILD_KEY" > "$OUTPUT/revision"
cp "$SOURCE/LICENSE" "$ROOT/native/video/RUNTIME-LICENSE"
