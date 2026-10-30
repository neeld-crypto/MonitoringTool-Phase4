#!/usr/bin/env bash
# Starts Skandha Media Services monitor. The web page is served on 127.0.0.1:4173 (reach it from your PC with an SSH tunnel, see README-LINUX.txt).
cd "$(dirname "$0")"
export PLAYPROBE_HOME="$PWD"
[ -x ./node/bin/node ] && export PATH="$PWD/node/bin:$PATH"
exec node server.cjs "$@"
