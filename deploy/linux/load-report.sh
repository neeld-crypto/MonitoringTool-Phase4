#!/usr/bin/env bash
# Prints how much CPU and memory PlayProbe, ffmpeg and srt-live-transmit use. Run it while channels are running:
#   ./load-report.sh          one report
#   ./load-report.sh 5        a new report every 5 seconds (Ctrl+C to stop)
interval="${1:-0}"
report() {
  echo "=== $(date '+%F %T')  cores: $(nproc)  load average: $(cut -d' ' -f1-3 /proc/loadavg)"
  free -m | awk 'NR==2 {printf "memory: %d MB used of %d MB\n", $3, $2}'
  # %CPU from ps is the average since each process started; top gives the current value.
  top -b -n 2 -d 2 | awk '/^top -/ {n++} n==2' | awk '
    NR>7 && ($12 ~ /ffmpeg|srt-live|node/) {cpu[$12]+=$9; mem[$12]+=$6; cnt[$12]++}
    END {for (p in cpu) printf "%-18s x%-2d  %6.1f%% of one core  %8.0f MB\n", p, cnt[p], cpu[p], mem[p]/1024}'
  echo
}
report
while [ "$interval" -gt 0 ]; do sleep "$interval"; report; done
