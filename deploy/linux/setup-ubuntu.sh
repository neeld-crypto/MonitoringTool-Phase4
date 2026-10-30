#!/usr/bin/env bash
# One-time setup of PlayProbe on Ubuntu / Debian. Run from the unpacked folder:  bash setup-ubuntu.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/3 ffmpeg and the SRT tools (needs sudo)"
need=()
command -v ffmpeg >/dev/null || need+=(ffmpeg)
command -v srt-live-transmit >/dev/null || need+=(srt-tools)
if [ ${#need[@]} -gt 0 ]; then
  if [ "$(id -u)" -eq 0 ]; then SUDO=""; elif command -v sudo >/dev/null; then SUDO="sudo"; else SUDO=""; fi
  if [ -n "${SUDO-x}" ] || [ "$(id -u)" -eq 0 ]; then
    $SUDO apt-get update -y && $SUDO apt-get install -y "${need[@]}" || echo "!! apt could not install: ${need[*]} (ask the administrator to run: sudo apt install -y ${need[*]})"
  fi
else
  echo "   already installed"
fi
command -v ffmpeg >/dev/null || { echo "!! ffmpeg is still missing; PlayProbe cannot monitor without it."; }
command -v srt-live-transmit >/dev/null || echo "!! srt-live-transmit is missing: SRT link statistics will be unavailable (basic mode)."

echo "== 2/3 Node.js 22 (kept inside this folder, no root needed)"
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ -x ./node/bin/node ]; then need_node=0; fi
if [ "$need_node" -eq 1 ]; then
  arch=$(uname -m); case "$arch" in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported CPU: $arch"; exit 1;; esac
  v=v22.12.0
  url="https://nodejs.org/dist/$v/node-$v-linux-$a.tar.xz"
  echo "   downloading $url"
  mkdir -p node
  curl -fsSL "$url" | tar -xJ -C node --strip-components=1
else
  echo "   already available"
fi

echo "== 3/3 permissions"
chmod +x start.sh load-report.sh setup-ubuntu.sh
echo
echo "Done. Start it with:  ./start.sh"
echo "SRT listener ports are UDP; open the ones you use, e.g.:  sudo ufw allow 9101:9106/udp"
