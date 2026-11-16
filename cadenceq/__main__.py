"""Finite JSON workload runner. No user code loading or file output."""

import argparse, json, sys
from .core import Scheduler


def main():
    p = argparse.ArgumentParser(
        description="Cooperative callback scheduler, virtual ticks not OS CPU time."
    )
    p.add_argument("--policy", choices=["fcfs", "rr", "sjf", "srtf"], default="rr")
    p.add_argument("--quantum", type=int, default=2)
    args = p.parse_args()
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("Workload exceeds 16 KiB")
        jobs = json.loads(raw.decode("utf-8"))
        out = Scheduler(jobs, args.policy, args.quantum).run()
    except (ValueError, UnicodeError, RecursionError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 2
    print(json.dumps(out, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
