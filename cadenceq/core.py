"""Original bounded runqueue. One call executes at most one trusted work callback."""

from collections import deque
from copy import deepcopy
from dataclasses import dataclass
import re

POLICIES = {"fcfs", "rr", "sjf", "srtf"}
MAX_TASKS = 12
MAX_TIME = 4096


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label} must be an integer in {low}..{high}")
    return value


def checksum_unit(value, unit):
    """One actual unit: 64 rounds of deterministic unsigned 32-bit arithmetic."""
    for j in range(64):
        value = ((value ^ (unit * 64 + j)) * 16777619) & 0xFFFFFFFF
    return value


@dataclass
class Task:
    name: str
    arrival: int
    bursts: list
    seed: int
    callback: object
    state: str = "new"
    burst: int = 0
    remaining: int = 0
    wake: int | None = None
    first: int | None = None
    finished: int | None = None
    cpu: int = 0
    wait: int = 0
    value: int = 0
    ticket: int = 0
    error: str | None = None


class Scheduler:
    """Finite integer-time workload, known CPU/sleep bursts, one cooperative worker.

    The core invokes callback(value, cpu_unit_index) for every selected work unit.
    Callbacks are trusted and atomic: this cannot interrupt blocking/hung code.
    No eval, subprocess execution, threads, wall-clock delays or host priorities.
    """

    def __init__(self, workload, policy="rr", quantum=2, callbacks=None):
        if type(policy) is not str or policy not in POLICIES:
            raise ValueError("Unknown policy")
        self.quantum = integer(quantum, 1, 32, "quantum")
        self.policy = policy
        if type(workload) is not list or not 1 <= len(workload) <= MAX_TASKS:
            raise ValueError("Expected 1..12 tasks")
        callbacks = {} if callbacks is None else callbacks
        if type(callbacks) is not dict:
            raise ValueError("callbacks must be a dictionary")
        self.tasks = []
        names = set()
        budget = 0
        latest = 0
        for row in workload:
            if type(row) is not dict or set(row) != {"id", "arrival", "bursts", "seed"}:
                raise ValueError("Each task needs exactly id, arrival, bursts, seed")
            name = row["id"]
            if (
                type(name) is not str
                or not re.fullmatch(r"[A-Z][A-Z0-9]{0,7}", name)
                or name in names
            ):
                raise ValueError("Unique task IDs must match [A-Z][A-Z0-9]{0,7}")
            names.add(name)
            arrival = integer(row["arrival"], 0, 128, "arrival")
            seed = integer(row["seed"], 0, 0xFFFFFFFF, "seed")
            bursts = row["bursts"]
            if type(bursts) is not list or len(bursts) not in (1, 3, 5, 7):
                raise ValueError(
                    "bursts must alternate CPU/sleep and end in CPU, length 1/3/5/7"
                )
            bursts = [integer(x, 1, 64, "burst") for x in bursts]
            budget += sum(bursts)
            latest = max(latest, arrival)
            cb = callbacks.get(name, checksum_unit)
            if not callable(cb):
                raise ValueError("Callback must be callable")
            self.tasks.append(
                Task(
                    name,
                    arrival,
                    bursts.copy(),
                    seed,
                    cb,
                    remaining=bursts[0],
                    value=seed,
                )
            )
        if budget + latest > MAX_TIME:
            raise ValueError("Conservative workload horizon exceeds 4096 ticks")
        if set(callbacks) - names:
            raise ValueError("Callback for unknown task")
        self._in_callback = False
        self.now = 0
        self.ready = deque()
        self.current = None
        self.slice = 0
        self.ticket = 0
        self.trace = []

    @property
    def complete(self):
        return all(t.state in ("done", "failed", "canceled") for t in self.tasks)

    def _enqueue(self, index):
        t = self.tasks[index]
        t.state = "ready"
        t.wake = None
        t.ticket = self.ticket
        self.ticket += 1
        self.ready.append(index)

    def _admit(self):
        # Simultaneous arrivals and wakeups follow original workload order.
        admitted = []
        for i, t in enumerate(self.tasks):
            if (t.state == "new" and t.arrival <= self.now) or (
                t.state == "sleeping" and t.wake <= self.now
            ):
                self._enqueue(i)
                admitted.append(t.name)
        return admitted

    def cancel(self, name):
        """Cancel between ticks only. Already completed/failed/canceled is a no-op."""
        if self._in_callback:
            raise RuntimeError("Cancel is allowed only between ticks")
        index = next((i for i, t in enumerate(self.tasks) if t.name == name), None)
        if index is None:
            raise ValueError("Unknown task")
        t = self.tasks[index]
        if t.state in ("done", "failed", "canceled"):
            return False
        if index in self.ready:
            self.ready.remove(index)
        if self.current == index:
            self.current = None
            self.slice = 0
        t.state = "canceled"
        t.finished = self.now
        t.wake = None
        return True

    def step(self):
        if self._in_callback:
            raise RuntimeError("Reentrant stepping is forbidden")
        if self.complete:
            return None
        if self.now >= MAX_TIME:
            raise RuntimeError("Scheduler horizon reached")
        admitted = self._admit()
        if self.policy == "srtf" and self.current is not None and self.ready:
            best = min(
                self.ready,
                key=lambda i: (self.tasks[i].remaining, self.tasks[i].ticket),
            )
            if self.tasks[best].remaining < self.tasks[self.current].remaining:
                self._enqueue(self.current)
                self.current = None
                self.slice = 0
        if self.current is None and self.ready:
            if self.policy in ("sjf", "srtf"):
                index = min(
                    self.ready,
                    key=lambda i: (self.tasks[i].remaining, self.tasks[i].ticket),
                )
                self.ready.remove(index)
            else:
                index = self.ready.popleft()
            self.current = index
            self.slice = 0
            self.tasks[index].state = "running"
        task = self.tasks[self.current] if self.current is not None else None
        for index in self.ready:
            self.tasks[index].wait += 1
        event = {
            "start": self.now,
            "end": self.now + 1,
            "task": task.name if task else None,
            "ready": [self.tasks[i].name for i in self.ready],
            "admitted": admitted,
            "outcome": "idle",
            "value": None,
        }
        if task:
            if task.first is None:
                task.first = self.now
            # A failing unit still consumes one scheduled tick, but stores no result.
            old = task.cpu
            task.cpu += 1
            task.remaining -= 1
            self.slice += 1
            try:
                self._in_callback = True
                try:
                    value = task.callback(task.value, old)
                finally:
                    self._in_callback = False
                if type(value) is not int or not 0 <= value <= 0xFFFFFFFF:
                    raise ValueError("Invalid callback result")
                task.value = value
                event["value"] = value
                event["outcome"] = "work"
            except Exception:
                task.state = "failed"
                task.error = "Work callback failed"
                task.finished = self.now + 1
                self.current = None
                self.slice = 0
                event["outcome"] = "failed"
            if task.state != "failed" and task.remaining == 0:
                if task.burst == len(task.bursts) - 1:
                    task.state = "done"
                    task.finished = self.now + 1
                    event["outcome"] = "done"
                else:
                    task.state = "sleeping"
                    task.wake = self.now + 1 + task.bursts[task.burst + 1]
                    task.burst += 2
                    task.remaining = task.bursts[task.burst]
                    event["outcome"] = "sleep"
                self.current = None
                self.slice = 0
        self.now += 1
        # Events at the boundary enter before a just-expired RR task goes back.
        event["boundary"] = self._admit()
        if (
            self.policy == "rr"
            and self.current is not None
            and self.slice == self.quantum
        ):
            self._enqueue(self.current)
            self.current = None
            self.slice = 0
        self.trace.append(event)
        return deepcopy(event)

    def snapshot(self):
        rows = []
        for t in self.tasks:
            rows.append(
                {
                    "id": t.name,
                    "state": t.state,
                    "cpu": t.cpu,
                    "wait": t.wait,
                    "first": t.first,
                    "finished": t.finished,
                    "response": None if t.first is None else t.first - t.arrival,
                    "turnaround": (
                        None
                        if t.state not in ("done", "failed")
                        else t.finished - t.arrival
                    ),
                    "value": t.value,
                    "remaining": t.remaining,
                    "wake": t.wake,
                    "error": t.error,
                }
            )
        return {
            "policy": self.policy,
            "quantum": self.quantum,
            "now": self.now,
            "complete": self.complete,
            "tasks": rows,
            "trace": [
                {
                    **e,
                    "ready": e["ready"].copy(),
                    "admitted": e["admitted"].copy(),
                    "boundary": e["boundary"].copy(),
                }
                for e in self.trace
            ],
        }

    def run(self):
        while not self.complete:
            self.step()
        return self.snapshot()
