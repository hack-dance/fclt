---
name: autoresearch
description: Set up and run a Codex-native autonomous experiment loop for benchmark-driven optimization work. Use when asked to run autoresearch, optimize code in repeated keep-or-revert iterations, or improve a fixed metric such as test time, build time, bundle size, training loss, or runtime latency.
---

# Autoresearch

Run an autonomous optimization loop inside Codex using normal shell and git primitives plus the bundled session scripts in this skill.

This is a Codex-native port of the `pi-autoresearch` workflow. Codex does not currently expose the Pi extension surface for custom slash commands, status widgets, injected runtime tools, or `before_agent_start` hooks, so this skill replaces those pieces with durable files and scripts.

## When To Use It

Use this skill when the user wants:

- repeated benchmark-guided edits with keep/discard decisions
- unattended optimization over a fixed workload
- an experiment log that survives context resets and branch changes
- a clean handoff to a later `autoresearch-finalize` pass

Do not use this skill for one-off tuning where a normal edit-test cycle is enough.

## Core Files

Create and maintain these files in the target repo:

- `autoresearch.md`: session brief, scope, constraints, wins, dead ends
- `autoresearch.sh`: the canonical benchmark command; outputs `METRIC name=value`
- `autoresearch.checks.sh`: optional correctness backpressure; tests/types/lint do not affect the primary metric
- `autoresearch.jsonl`: append-only session log
- `autoresearch.ideas.md`: deferred promising ideas

Keep the filenames stable. The finalize skill assumes them.

## Codex-Native Workflow

1. Clarify the work unit before starting.
   Goal, primary metric, direction, command, file scope, constraints, stop condition, and verification path.
2. Create or resume an autoresearch branch.
   Use `autoresearch/<slug>-<date>` for new sessions unless the repo already has an active branch to continue.
3. Read the in-scope code deeply before the first edit.
   Do not start with random perturbations.
4. Write `autoresearch.md` and `autoresearch.sh`.
   If correctness must hold during the loop, also write `autoresearch.checks.sh`.
5. Initialize the log with the bundled script:

```bash
python3 "$CODEX_HOME/skills/autoresearch/scripts/init_session.py" \
  --name "Optimize <goal>" \
  --metric-name "<metric>" \
  --metric-unit "<unit>" \
  --direction lower
```

6. Run the baseline:

```bash
bash autoresearch.sh
```

7. After every run, append a structured result with the bundled script:

```bash
python3 "$CODEX_HOME/skills/autoresearch/scripts/log_run.py" \
  --commit "$(git rev-parse --short=7 HEAD)" \
  --metric <number> \
  --status keep \
  --description "baseline" \
  --metrics-json '{"secondary_metric": 123}' \
  --asi-json '{"hypothesis":"baseline","next_action_hint":"start exploring"}'
```

8. Loop.
   Make one coherent change, run `autoresearch.sh`, decide keep or discard, log it, then either keep the commit or revert the change.

## Keep Or Discard Rules

- The primary metric decides by default.
- Prefer simpler code when the metric is neutral.
- For noisy workloads, re-run strong candidates before trusting a marginal win.
- On crashes or correctness failures, log the failure with actionable ASI before reverting.
- Do not let failed experiments disappear without a record.

## Benchmark Script Rules

`autoresearch.sh` should:

- use `set -euo pipefail`
- run the same workload every iteration
- print the primary metric as `METRIC <name>=<value>`
- print any secondary metrics in the same format
- stay fast and stable

For fast noisy benchmarks, run multiple internal trials and report a median.

## Checks Script Rules

If `autoresearch.checks.sh` exists:

- run it after every benchmark candidate that would otherwise be a keep
- treat failures as `checks_failed`
- do not include checks time in the primary metric
- revert code after logging the failed candidate unless the user asked to inspect it

## JSONL Contract

Use the bundled scripts instead of hand-editing the log.

`init_session.py` writes config headers like:

```json
{"type":"config","name":"Optimize tests","metricName":"total_s","metricUnit":"s","bestDirection":"lower"}
```

`log_run.py` writes result lines like:

```json
{"run":4,"commit":"abc1234","metric":12.4,"metrics":{"checks_s":4.1},"status":"keep","description":"reduce worker churn","timestamp":1774886400000,"segment":0,"confidence":2.3,"iterationTokens":null,"asi":{"hypothesis":"cache setup work"}}
```

Keep this format compatible with the finalize skill.

## Structured Memory

Always record high-signal ASI in the log entry:

- `hypothesis`
- `rollback_reason` for discard or crash
- `next_action_hint`
- any bottleneck clue or surprising observation worth preserving

Update `autoresearch.md` when the strategy changes, not after every trivial run.

## Viewing Runs

Use the bundled dashboard script when you want a quick summary of the current session log:

```bash
node "$CODEX_HOME/plugins/autoresearch/scripts/autoresearch-dashboard.js" \
  --file autoresearch.jsonl
```

Useful flags:

- `--limit 20`: show more recent runs
- `--watch`: refresh continuously
- `--interval 2000`: refresh every two seconds instead of every second

## What This Port Does Not Have

Compared with `pi-autoresearch`, this Codex skill does not currently provide:

- a custom `/autoresearch` command
- runtime-only tools like `init_experiment`, `run_experiment`, `log_experiment`
- the Pi inline status widget or collapsible transcript dashboard
- automatic prompt injection on every turn
- automatic keep-commit or discard-revert behavior

Use normal Codex shell and git tools for those steps. This plugin does include an on-demand terminal dashboard script, but not the always-on Pi extension UI. If you later want tool parity, build an MCP server and wrap it in a local plugin.
