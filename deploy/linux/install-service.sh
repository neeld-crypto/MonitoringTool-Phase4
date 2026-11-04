#!/usr/bin/env bash
# Installs Pulse as a systemd service: it keeps running after PuTTY closes, starts at boot and restarts after a crash.
# Run once from the unpacked folder:  bash install-service.sh      (asks for sudo)
# Stop any copy started by hand with ./start.sh first (Ctrl+C), or the port is busy.
set -euo pipefail
cd "$(dirname "$0")"
dir="$PWD"
user="${SUDO_USER:-$(id -un)}"
[ "$user" = root ] && echo "Run this as your normal user (it uses sudo itself), not as root." && exit 1
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

chmod +x start.sh
[ -f .env ] || printf '# Settings kept out of git; see .env.example in the source.\n# SRT_WEBHOOK_URL=https://hooks.slack.com/services/...\n# SRT_WEBHOOK_KIND=slack\n' > .env

sed -e "s|^User=.*|User=$user|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$dir|" \
    -e "s|^ExecStart=.*|ExecStart=/bin/bash $dir/start.sh|" \
    playprobe.service | $SUDO tee /etc/systemd/system/playprobe.service >/dev/null

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now playprobe
sleep 2
$SUDO systemctl --no-pager --lines=5 status playprobe || true
echo
echo "Done. Pulse now runs in the background and survives closing PuTTY and rebooting."
echo "  logs:     journalctl -u playprobe -f"
echo "  restart:  sudo systemctl restart playprobe     (after editing .env or updating the files)"
echo "  stop:     sudo systemctl stop playprobe"
