#!/usr/bin/env bash
# Starts Pulse. The page is served on 127.0.0.1:4173 unless HOST is set (HOST=0.0.0.0 ./start.sh opens it by the server IP; see README-LINUX.txt).
# Sign-in: PULSE_USER / PULSE_PASSWORD (default skandha / skandha@123).
cd "$(dirname "$0")"
export PLAYPROBE_HOME="$PWD"
[ -x ./node/bin/node ] && export PATH="$PWD/node/bin:$PATH"
exec node server.cjs "$@"
