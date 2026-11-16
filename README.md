# Cadenceq

An original single-worker cooperative callback scheduler with an interactive run queue. FCFS, round robin, shortest-job-first and shortest-remaining-time policies select real work callbacks, one unit at a time.

**Logical time, not host CPU scheduling.** Cadenceq is an educational bounded executor and policy model. It does not manage processes, threads, host priorities, CPU registers, kernel interrupts, actual I/O or wall-clock deadlines. It cannot interrupt a blocking callback. SRTF switches only after a callback returns.

## Run locally

Python 3.10+ and the standard library are enough for the native library and CLI. There are no runtime dependencies or install scripts.

```sh
python3 -m cadenceq --policy rr --quantum 2 <<'JSON'
[
  {"id":"A","arrival":0,"bursts":[5,2,3],"seed":11},
  {"id":"B","arrival":1,"bursts":[2],"seed":22}
]
JSON
```

The CLI reads at most 16 KiB of UTF-8 JSON from stdin and writes one JSON result to stdout. Invalid workloads produce JSON errors on stderr and exit 2. Reading stdin waits for EOF; it is not a timed stream. The CLI loads no user-supplied code or files, does not write files, and never executes shell commands.

For the browser app:

```sh
python3 -m http.server 8000 --directory docs --bind 127.0.0.1
```

Open `http://127.0.0.1:8000`. Start from a preset, edit tasks, choose a policy, then **Apply & reset**. **Step** executes one unit or idle tick; **Play** advances at a display cadence; **Finish** runs to the end. Play's 180ms interval is an animation choice, not a CPU quantum or timing guarantee. Changing input pauses and marks the old trace stale until applied. There are no external requests, uploads, telemetry or persistence. Reset and closing the tab lose all state. The static host may still log asset requests.

The browser executes an independent JavaScript scheduler and a fixed arithmetic work callback. It is not a remote Python service and does not load arbitrary code. The chart comes from execution events. Native tests separately verify that custom callbacks really run in selected order, rather than just manufacturing a trace. The hero queue is an illustration, not a live schedule.

## Task contract

Each task is an object with exactly these fields:

| Field     | Meaning                                            | Bound                                    |
| --------- | -------------------------------------------------- | ---------------------------------------- |
| `id`      | Unique case-sensitive identifier                   | `[A-Z][A-Z0-9]{0,7}`                     |
| `arrival` | First eligible logical boundary                    | Integer 0..128                           |
| `bursts`  | Alternating CPU/sleep/CPU durations, ending in CPU | 1,3,5 or 7 positive integers, each 1..64 |
| `seed`    | Initial unsigned work state                        | Integer 0..4294967295                    |

There must be 1..12 tasks. Boolean, fractional and out-of-range numeric fields are rejected. The library accepts a quantum 1..32; the UI slider offers 1..12. To bound the trace, `max(arrival) + sum(all CPU and sleep bursts)` must not exceed 4096. This is a conservative upper bound: overlapping sleeps can make a workload's actual completion much earlier. A finite workload and returned callbacks imply eventual completion; no fairness or no-starvation promise applies to general operating systems or endless arrivals.

The native input list and burst lists are copied on construction. Snapshots and returned events are detached from internal trace state. Do not mutate live implementation attributes (`tasks`, queue, current state) or use a scheduler concurrently. The browser API likewise expects ordinary JSON-shaped objects and trusted callbacks. This is not a hostile-object or arbitrary-code sandbox.

### Actual work

Each selected unit invokes `callback(value, unit_index)` exactly once. `unit_index` starts at 0 per task and counts attempted CPU units across all that task's CPU bursts. The callback returns the next unsigned 32-bit integer state. The default does 64 rounds:

```text
for j = 0..63:
    value = ((value XOR (unit_index * 64 + j)) * 16777619) modulo 2^32
```

Python masks integer arithmetic; JavaScript uses `Math.imul` and an unsigned shift. This is an invented deterministic arithmetic workload, **not a cryptographic hash or authentication scheme**. A task's final work receipt is independent of the scheduling policy when its callback is deterministic and it completes. The timing metrics are not performance benchmarks.

### Trusted custom callbacks

```python
from cadenceq import Scheduler

calls = []
def accumulate(value, unit_index):
    calls.append(unit_index)   # real application work runs here
    return value + 10

jobs = [{"id": "A", "arrival": 0, "bursts": [3], "seed": 1}]
scheduler = Scheduler(jobs, policy="rr", quantum=1,
                      callbacks={"A": accumulate})
result = scheduler.run()
assert calls == [0, 1, 2]
assert result["tasks"][0]["value"] == 31
```

No task callback is run by the constructor. Use `step()` to invoke at most one callback or advance one idle tick, `run()` to reach terminal state, and `snapshot()` to inspect. `step()` on a completed scheduler returns `None` (JS `null`) without changing state.

Callbacks are trusted and atomic. A callback that blocks or never returns blocks the scheduler and is outside its resource guarantee. There is no timeout, process isolation, thread safety, side-effect rollback, scheduling of external processes or forced preemption. A normal Python `Exception` (or JS throw) and invalid return value fail only that task with a generic error. The failed attempt consumes one tick and one attempted CPU unit, keeps the prior work state, and is **never retried**. Python process-control `BaseException` signals are not swallowed. Callback exception text is not put in the trace. Already-performed external side effects are not undone. Only use side effects you are prepared to own.

Reentrant `step()` and `cancel()` calls from inside callbacks are rejected; an uncaught rejection fails that task. Do not mutate internals or recursively call `run()`/advance from callbacks. There is one worker, with no interleaving inside a unit.

`cancel(id)` is allowed only between ticks. It marks a new, ready, running or sleeping task canceled, removes it from dispatch and preserves completed work. It cannot interrupt an in-progress callback, roll back a callback, or cancel a process elsewhere. Terminal task cancellation is an idempotent no-op; an unknown ID is an error. Canceled tasks have no turnaround result, including cancellation before arrival. Partial receipts are labeled as such. There are no dynamic submissions after construction, dependencies, distributed workers, retries or persistent queues.

## Exact scheduling semantics

The worker covers half-open intervals `[t, t+1)`. CPU bursts count callback units, not estimated wall time. A task keeps the worker across adjacent units unless its policy yields at a boundary, its burst finishes, it fails or it is canceled.

1. At the initial boundary, admit eligible arrivals in input-list order.
2. If SRTF has a strictly shorter ready current burst, put the former current task at the tail with a new queue-entry ticket. Equal remaining time does **not** displace the current task.
3. If the worker is free, choose from the ready set. Execute one callback or one idle tick. Other ready tasks each accumulate one waiting tick.
4. At the end of the unit, finish or enter sleep if the CPU burst ended; a failure becomes terminal. A sleep of 2 entered at boundary 3 wakes at 5, not 4.
5. Advance the clock and admit all arrivals and wakeups at that boundary, jointly in original input order. They append behind tasks already ready. Only then append a running RR task whose quantum just expired. This makes boundary event ordering deterministic.

| Policy | Selection                                                                  | Retains current task until                                          |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| FCFS   | Oldest queue entry                                                         | Current CPU burst ends                                              |
| RR     | Oldest queue entry                                                         | Current burst ends or quantum expires                               |
| SJF    | Shortest known current CPU burst; queue-entry ticket breaks ties           | Current burst ends                                                  |
| SRTF   | Shortest remaining current CPU burst; queue-entry ticket breaks ready ties | A strictly shorter ready burst exists at the next callback boundary |

SJF/SRTF use **current CPU burst**, not total future task CPU work, and require known durations. Newly woken tasks join the same queue, not a hidden priority queue. RR quantum resets on dispatch and wake; a lone task is requeued too. Contiguous same-task timeline spans are merged, so a span can exceed one quantum when nobody else ran. That is not a claim of one uninterrupted OS time slice. No context-switch overhead, CPU cache effects, priorities, aging or real I/O cost is modeled.

A sleeping task uses no worker units and no ready-wait ticks. The model advances through idle intervals one tick at a time. A native failed callback still consumes its attempted unit. The UI shows only fixed known-good work; injected failures are covered natively.

## Trace and metrics

`run()` returns policy, quantum, logical clock, terminal flag, task ledger and a bounded per-tick trace. Each event includes start/end, task (or null for idle), the other ready IDs at selection, admissions at start and end boundaries, outcome, and the actual returned work state. An event's `boundary` list belongs to its end time; those events do not appear again in the next event's `admitted` list. Snapshot trace order is execution order. Reset starts a new run.

- CPU units: attempted work callbacks, including a failed unit.
- Ready wait: elapsed ticks spent ready but not selected; excludes sleep and pre-arrival time.
- Response: first selected start minus arrival; null until selected.
- Turnaround: terminal finish minus arrival for done/failed tasks; null for unfinished/canceled tasks.
- Work receipt: current integer callback state, possibly partial. Zero CPU units means the seed, not completed work.

For a successful task, `turnaround = CPU + ready wait + planned sleep`. Response is not added again. The browser mean wait includes **all** tasks (also unfinished/canceled); mean turnaround includes **done** tasks only and shows `-` until any finish. Busy/elapsed divides attempted work ticks by elapsed ticks, not host CPU utilization. Zero elapsed shows 0%. Ledger response/turn values are logical ticks. Cancellation can reduce final completed count below total tasks, while all tasks are terminal.

The browser queue shows a retained current task first, then ready tasks in policy order. SRTF may replace that retained task at the next step. New/sleeping tasks are listed separately. Timeline spans are a supplemental fixed-width chart with local horizontal scroll. Core metrics, task identities, receipts, states and the decision inspector wrap at phone widths. Span buttons inspect the span's last tick; event-by-event inspection is available through stepping. All original work remains visible in the ledger.

## Tests

```sh
make test
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:browser
```

Native tests use analytic FCFS/RR/SJF/SRTF and sleep/boundary fixtures, actual callback order/results/failures, cancellation states, reentrant rejection, input/snapshot immutability, strict schema/limits, CLI errors, work/time conservation and 1,200 randomized schedules against a separate scan/table oracle. The oracle does not use the production runqueue or checksum implementation.

JS tests include 1,104 full-state Python/JS comparisons (all trace events, ledger metrics and callback results, including 100 interleaved-cancellation cases), policy-invariant results, cancellation/failure/reentrancy, invalid inputs and sparse arrays. Parity is not proof, so native analytic fixtures and the separate oracle remain independent checks. Browser tests exercise five widths, actual step/results, all policies, sleep/idle/cancel, play/pause, stale and invalid inputs, add/remove, a 12-task/3072-unit execution, no HTML injection, keyboard navigation, touch size and no page-level overflow or third-party requests. Chromium only; other browsers, screen readers and arbitrary callbacks are not certified.

CI uses Python 3.10/3.12/3.13, Node 22/Playwright, a pinned lockfile, Gitleaks full-history scanning and scoped Semgrep rules with read-only Actions permissions. No credentials, real customer tasks or personal demo data are needed.

## Source and references

Original native library, JS runtime, UI, art and tests are by Aditya Kulkarni under MIT. The Python runtime is standard library only; Playwright 1.56.1 is a pinned development dependency, not a runtime service. No code is imported from a kernel or scheduling package.

- [OSTEP chapter 7: scheduling introduction](https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-sched.pdf): workload assumptions, turnaround and response metrics, FIFO/RR tradeoffs.
- [OpenOS: simple scheduling policies](https://openosorg.github.io/openos/textbook/scheduling/sch-simple.html): FCFS, SJF, RR and known-runtime/starvation caveats.
- [OSDev scheduling algorithms](https://wiki.osdev.org/Scheduling_Algorithms): policy descriptions. Cadenceq deliberately does not implement kernel timer preemption.
- [Python deque](https://docs.python.org/3/library/collections.html#collections.deque): standard-library queue interface. Policy scans remain O(tasks), with at most 12 tasks; this is not an O(1) production scheduler claim.
- [MDN Math.imul](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul): unsigned work-state parity through 32-bit multiplication/masking.
