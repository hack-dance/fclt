#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize or re-initialize an autoresearch session log."
    )
    parser.add_argument("--name", required=True)
    parser.add_argument("--metric-name", required=True)
    parser.add_argument("--metric-unit", default="")
    parser.add_argument("--direction", choices=["lower", "higher"], default="lower")
    parser.add_argument("--workdir", default=".")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workdir = Path(args.workdir).expanduser().resolve()
    jsonl_path = workdir / "autoresearch.jsonl"
    entry = {
        "type": "config",
        "name": args.name,
        "metricName": args.metric_name,
        "metricUnit": args.metric_unit,
        "bestDirection": args.direction,
    }
    with jsonl_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
    print(json.dumps({"ok": True, "path": str(jsonl_path), "config": entry}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
