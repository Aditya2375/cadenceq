import json, sys
from cadenceq import Scheduler

cases = json.load(sys.stdin)
outputs = []
for c in cases:
    scheduler = Scheduler(c["jobs"], c["policy"], c["quantum"])
    for action in c.get("actions", []):
        for _ in range(action["steps"]):
            scheduler.step()
        scheduler.cancel(action["cancel"])
    outputs.append(scheduler.run())
print(json.dumps(outputs, separators=(",", ":")))
