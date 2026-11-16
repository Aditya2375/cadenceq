// Original cooperative single-worker scheduler. Integer logical time, not host CPU time.
const policies = new Set(["fcfs", "rr", "sjf", "srtf"]);
function integer(v, lo, hi, label) {
  if (!Number.isInteger(v) || v < lo || v > hi)
    throw Error(`${label} must be an integer in ${lo}..${hi}`);
  return v;
}
export function checksumUnit(value, unit) {
  for (let j = 0; j < 64; j++)
    value = Math.imul(value ^ (unit * 64 + j), 16777619) >>> 0;
  return value;
}
export class Scheduler {
  constructor(workload, policy = "rr", quantum = 2, callbacks = {}) {
    if (!policies.has(policy)) throw Error("Unknown policy");
    this.quantum = integer(quantum, 1, 32, "quantum");
    this.policy = policy;
    if (!Array.isArray(workload) || workload.length < 1 || workload.length > 12)
      throw Error("Expected 1..12 tasks");
    if (!callbacks || typeof callbacks !== "object" || Array.isArray(callbacks))
      throw Error("callbacks must be a dictionary");
    let budget = 0,
      latest = 0;
    const names = new Set();
    this.tasks = Array.from(workload, (row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "arrival,bursts,id,seed"
      )
        throw Error("Each task needs exactly id, arrival, bursts, seed");
      const name = row.id;
      if (
        typeof name !== "string" ||
        !/^[A-Z]/.test(name) ||
        /[^A-Z0-9]/.test(name) ||
        name.length > 8 ||
        names.has(name)
      )
        throw Error("Unique task IDs must match [A-Z][A-Z0-9]{0,7}");
      names.add(name);
      const arrival = integer(row.arrival, 0, 128, "arrival"),
        seed = integer(row.seed, 0, 0xffffffff, "seed");
      if (
        !Array.isArray(row.bursts) ||
        ![1, 3, 5, 7].includes(row.bursts.length)
      )
        throw Error(
          "bursts must alternate CPU/sleep and end in CPU, length 1/3/5/7",
        );
      const bursts = Array.from(row.bursts, (x) => integer(x, 1, 64, "burst"));
      budget += bursts.reduce((a, b) => a + b, 0);
      latest = Math.max(latest, arrival);
      const callback = Object.hasOwn(callbacks, name)
        ? callbacks[name]
        : checksumUnit;
      if (typeof callback !== "function")
        throw Error("Callback must be callable");
      return {
        name,
        arrival,
        bursts,
        seed,
        callback,
        state: "new",
        burst: 0,
        remaining: bursts[0],
        wake: null,
        first: null,
        finished: null,
        cpu: 0,
        wait: 0,
        value: seed,
        ticket: 0,
        error: null,
      };
    });
    if (budget + latest > 4096)
      throw Error("Conservative workload horizon exceeds 4096 ticks");
    if (Object.keys(callbacks).some((k) => !names.has(k)))
      throw Error("Callback for unknown task");
    this.inCallback = false;
    this.now = 0;
    this.ready = [];
    this.current = null;
    this.slice = 0;
    this.ticket = 0;
    this.trace = [];
  }
  get complete() {
    return this.tasks.every((t) =>
      ["done", "failed", "canceled"].includes(t.state),
    );
  }
  enqueue(i) {
    const t = this.tasks[i];
    t.state = "ready";
    t.wake = null;
    t.ticket = this.ticket++;
    this.ready.push(i);
  }
  admit() {
    const admitted = [];
    this.tasks.forEach((t, i) => {
      if (
        (t.state === "new" && t.arrival <= this.now) ||
        (t.state === "sleeping" && t.wake <= this.now)
      ) {
        this.enqueue(i);
        admitted.push(t.name);
      }
    });
    return admitted;
  }
  cancel(name) {
    if (this.inCallback) throw Error("Cancel is allowed only between ticks");
    const i = this.tasks.findIndex((t) => t.name === name);
    if (i < 0) throw Error("Unknown task");
    const t = this.tasks[i];
    if (["done", "failed", "canceled"].includes(t.state)) return false;
    this.ready = this.ready.filter((x) => x !== i);
    if (this.current === i) {
      this.current = null;
      this.slice = 0;
    }
    t.state = "canceled";
    t.finished = this.now;
    t.wake = null;
    return true;
  }
  best() {
    return this.ready.reduce((a, b) =>
      this.tasks[b].remaining < this.tasks[a].remaining ||
      (this.tasks[b].remaining === this.tasks[a].remaining &&
        this.tasks[b].ticket < this.tasks[a].ticket)
        ? b
        : a,
    );
  }
  step() {
    if (this.inCallback) throw Error("Reentrant stepping is forbidden");
    if (this.complete) return null;
    if (this.now >= 4096) throw Error("Scheduler horizon reached");
    const admitted = this.admit();
    if (
      this.policy === "srtf" &&
      this.current !== null &&
      this.ready.length &&
      this.tasks[this.best()].remaining < this.tasks[this.current].remaining
    ) {
      this.enqueue(this.current);
      this.current = null;
      this.slice = 0;
    }
    if (this.current === null && this.ready.length) {
      const i = ["sjf", "srtf"].includes(this.policy)
        ? this.best()
        : this.ready[0];
      this.ready.splice(this.ready.indexOf(i), 1);
      this.current = i;
      this.slice = 0;
      this.tasks[i].state = "running";
    }
    const task = this.current === null ? null : this.tasks[this.current];
    for (const i of this.ready) this.tasks[i].wait++;
    const event = {
      start: this.now,
      end: this.now + 1,
      task: task ? task.name : null,
      ready: this.ready.map((i) => this.tasks[i].name),
      admitted,
      outcome: "idle",
      value: null,
    };
    if (task) {
      if (task.first === null) task.first = this.now;
      const old = task.cpu++;
      task.remaining--;
      this.slice++;
      try {
        this.inCallback = true;
        let value;
        try {
          value = task.callback(task.value, old);
        } finally {
          this.inCallback = false;
        }
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
          throw Error("Invalid callback result");
        task.value = value;
        event.value = value;
        event.outcome = "work";
      } catch {
        task.state = "failed";
        task.error = "Work callback failed";
        task.finished = this.now + 1;
        this.current = null;
        this.slice = 0;
        event.outcome = "failed";
      }
      if (task.state !== "failed" && task.remaining === 0) {
        if (task.burst === task.bursts.length - 1) {
          task.state = "done";
          task.finished = this.now + 1;
          event.outcome = "done";
        } else {
          task.state = "sleeping";
          task.wake = this.now + 1 + task.bursts[task.burst + 1];
          task.burst += 2;
          task.remaining = task.bursts[task.burst];
          event.outcome = "sleep";
        }
        this.current = null;
        this.slice = 0;
      }
    }
    this.now++;
    event.boundary = this.admit();
    if (
      this.policy === "rr" &&
      this.current !== null &&
      this.slice === this.quantum
    ) {
      this.enqueue(this.current);
      this.current = null;
      this.slice = 0;
    }
    this.trace.push(event);
    return structuredClone(event);
  }
  snapshot() {
    return {
      policy: this.policy,
      quantum: this.quantum,
      now: this.now,
      complete: this.complete,
      tasks: this.tasks.map((t) => ({
        id: t.name,
        state: t.state,
        cpu: t.cpu,
        wait: t.wait,
        first: t.first,
        finished: t.finished,
        response: t.first === null ? null : t.first - t.arrival,
        turnaround: ["done", "failed"].includes(t.state)
          ? t.finished - t.arrival
          : null,
        value: t.value,
        remaining: t.remaining,
        wake: t.wake,
        error: t.error,
      })),
      trace: structuredClone(this.trace),
    };
  }
  run() {
    while (!this.complete) this.step();
    return this.snapshot();
  }
}
