#!/usr/bin/env python3

import argparse
import json
import math
import statistics
import time
from pathlib import Path
from typing import Any


VALID_STATUSES = {"keep", "discard", "crash", "checks_failed"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append one autoresearch run to autoresearch.jsonl.")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--metric", required=True, type=float)
    parser.add_argument("--status", required=True, choices=sorted(VALID_STATUSES))
    parser.add_argument("--description", required=True)
    parser.add_argument("--metrics-json", default="{}")
    parser.add_argument("--asi-json", default="")
    parser.add_argument("--iteration-tokens", type=int)
    parser.add_argument("--workdir", default=".")
    return parser.parse_args()


def load_json_object(raw: str, flag_name: str) -> dict[str, Any]:
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise SystemExit(f"{flag_name} must decode to a JSON object")
    return value


def load_entries(jsonl_path: Path) -> list[dict[str, Any]]:
    if not jsonl_path.exists():
        raise SystemExit(f"{jsonl_path} does not exist. Run init_session.py first.")
    entries: list[dict[str, Any]] = []
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))
    return entries


def current_segment(entries: list[dict[str, Any]]) -> int:
    segment = -1
    for entry in entries:
        if entry.get("type") == "config":
            segment += 1
    if segment < 0:
        raise SystemExit("autoresearch.jsonl has no config entry. Run init_session.py first.")
    return segment


def current_segment_runs(entries: list[dict[str, Any]], segment: int) -> list[dict[str, Any]]:
    return [entry for entry in entries if entry.get("segment") == segment]


def compute_confidence(entries: list[dict[str, Any]], segment: int) -> float | None:
    runs = [
        entry
        for entry in current_segment_runs(entries, segment)
        if isinstance(entry.get("metric"), (int, float)) and entry.get("metric", 0) > 0
    ]
    if len(runs) < 3:
        return None

    config = next(
        (entry for entry in reversed(entries) if entry.get("type") == "config"),
        None,
    )
    if not config:
        return None

    values = [float(entry["metric"]) for entry in runs]
    median = statistics.median(values)
    deviations = [abs(value - median) for value in values]
    mad = statistics.median(deviations)
    if mad <= 0:
        return None

    baseline = float(runs[0]["metric"])
    direction = config.get("bestDirection", "lower")
    if direction == "higher":
        best = max(values)
        best_delta = best - baseline
    else:
        best = min(values)
        best_delta = baseline - best

    if best_delta <= 0:
        return None

    confidence = abs(best_delta) / mad
    if not math.isfinite(confidence):
        return None
    return confidence


def main() -> int:
    args = parse_args()
    metrics = load_json_object(args.metrics_json, "--metrics-json")
    asi = load_json_object(args.asi_json, "--asi-json")
    workdir = Path(args.workdir).expanduser().resolve()
    jsonl_path = workdir / "autoresearch.jsonl"

    entries = load_entries(jsonl_path)
    segment = current_segment(entries)
    run_number = sum(1 for entry in entries if entry.get("type") != "config") + 1

    entry: dict[str, Any] = {
        "run": run_number,
        "commit": args.commit,
        "metric": args.metric,
        "metrics": metrics,
        "status": args.status,
        "description": args.description,
        "timestamp": int(time.time() * 1000),
        "segment": segment,
        "confidence": None,
        "iterationTokens": args.iteration_tokens,
    }
    if asi:
        entry["asi"] = asi

    confidence = compute_confidence(entries + [entry], segment)
    entry["confidence"] = confidence

    with jsonl_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")

    print(json.dumps({"ok": True, "path": str(jsonl_path), "entry": entry}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
