#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT="$ROOT/android/app/src/main/jniLibs"
NDK_HOME=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}
if [ -z "$NDK_HOME" ] && [ -n "${ANDROID_HOME:-}" ]; then NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"; fi
if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then echo "ANDROID_NDK_HOME is required" >&2; exit 2; fi
case "$(uname -s)" in Linux) HOST_TAG=linux-x86_64 ;; Darwin) HOST_TAG=darwin-x86_64 ;; *) echo "unsupported host" >&2; exit 2 ;; esac
API=${ANDROID_API_LEVEL:-23}
BUILD_VERSION=${BUILD_VERSION:-0.1.0-dev}
for ABI in arm64-v8a armeabi-v7a x86_64; do
  case "$ABI" in
    arm64-v8a) GOARCH=arm; GOARM=; GOARCH=arm64; TARGET=aarch64-linux-android ;;
    armeabi-v7a) GOARCH=arm; GOARM=7; TARGET=armv7a-linux-androideabi ;;
    x86_64) GOARCH=amd64; GOARM=; TARGET=x86_64-linux-android ;;
  esac
  CC="$NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin/${TARGET}${API}-clang"
  if [ ! -x "$CC" ]; then echo "missing compiler: $CC" >&2; exit 2; fi
  mkdir -p "$OUT/$ABI"
  CGO_ENABLED=1 GOOS=android GOARCH="$GOARCH" GOARM="$GOARM" CC="$CC" go build -trimpath -buildmode=pie -ldflags "-s -w -X main.buildVersion=$BUILD_VERSION" -o "$OUT/$ABI/libkafeitv.so" ./core/cmd/kafeitv
done
