#!/usr/bin/env bash
set -euo pipefail

run_once() {
  local out_file time_file
  out_file=$(mktemp)
  time_file=$(mktemp)
  /usr/bin/time -lp bun run ./src/index.ts --help >"$out_file" 2>"$time_file"
  python3 - "$time_file" <<'PY'
import sys
from pathlib import Path

time_path = Path(sys.argv[1])
real = None
maxrss = None
for line in time_path.read_text().splitlines():
    if line.startswith("real "):
        real = float(line.split()[1])
    elif line.startswith("maximum resident set size "):
        maxrss = int(line.split()[-1])

if real is None or maxrss is None:
    raise SystemExit("failed to parse timing output")

print(f"{real:.6f} {maxrss}")
PY
  rm -f "$out_file" "$time_file"
}

declare -a reals=()
declare -a rss=()

for i in 1 2 3 4 5 6 7; do
  result=$(run_once)
  real=$(awk '{print $1}' <<<"$result")
  maxrss=$(awk '{print $2}' <<<"$result")
  if [[ "$i" -gt 1 ]]; then
    reals+=("$real")
    rss+=("$maxrss")
  fi
done

median() {
  printf '%s\n' "$@" | sort -n | awk '
    { values[NR] = $1 }
    END {
      if (NR == 0) exit 1
      if (NR % 2 == 1) {
        print values[(NR + 1) / 2]
      } else {
        print (values[NR / 2] + values[(NR / 2) + 1]) / 2
      }
    }
  '
}

median_real=$(median "${reals[@]}")
median_rss=$(median "${rss[@]}")
help_ms=$(python3 - "$median_real" <<'PY'
import sys
print(f"{float(sys.argv[1]) * 1000:.3f}")
PY
)

printf 'METRIC help_ms=%s\n' "$help_ms"
printf 'METRIC help_maxrss_kb=%s\n' "$median_rss"
