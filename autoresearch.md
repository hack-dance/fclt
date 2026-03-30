# Autoresearch: CLI help startup latency

## Objective
Reduce the startup latency of `bun run ./src/index.ts --help` by cutting eager work performed before argument dispatch. This is a cheap benchmark that exercises real CLI startup behavior and should be sensitive to unnecessary module loading in `src/index.ts`.

## Metrics
- **Primary**: `help_ms` (`ms`, lower is better)
- **Secondary**: `help_peak_bytes` (`bytes`, lower is better but only advisory)

## How to Run
`bash autoresearch.sh`

The benchmark runs the help command multiple times via `/usr/bin/time -lp`, discards the first warm-up run, and reports the median wall-clock time in milliseconds plus the median peak memory reading from the timing output.

## Files In Scope
- `src/index.ts`: primary candidate; currently imports most command modules eagerly

## Off Limits
- behavior changes to command output
- unrelated command modules unless needed to enable lazy dispatch cleanly

## Constraints
- `bun run ./src/index.ts --help` output must remain correct
- changes should stay readable and maintainable
- prefer lazy dispatch or other structural simplification over hacks

## What's Been Tried
- Baseline only so far.
