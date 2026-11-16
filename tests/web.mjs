import { Scheduler, checksumUnit } from "../docs/core.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
let checks = 0;
const ok = (x, m) => {
  assert.ok(x, m);
  checks++;
};
const job = (id = "A", arrival = 0, bursts = [3], seed = 1) => ({
  id,
  arrival,
  bursts,
  seed,
});
const calls = [];
const cb = (id) => (v, n) => {
  calls.push([id, n, v]);
  return v + 10;
};
let s = new Scheduler([job("A", 0, [2]), job("B", 0, [2])], "rr", 1, {
  A: cb("A"),
  B: cb("B"),
});
s.run();
ok(
  JSON.stringify(calls) ===
    JSON.stringify([
      ["A", 0, 1],
      ["B", 0, 1],
      ["A", 1, 11],
      ["B", 1, 11],
    ]),
  "real callback execution",
);
for (const p of ["fcfs", "rr", "sjf", "srtf"]) {
  s = new Scheduler([job("A", 0, [5, 3, 2]), job("B", 1, [2])], p);
  const o = s.run();
  ok(o.complete, "complete " + p);
  for (const t of o.tasks)
    ok(
      t.turnaround === t.cpu + t.wait + (t.id === "A" ? 3 : 0),
      "time accounting",
    );
  ok(
    o.tasks[0].value ===
      Array.from({ length: 7 }).reduce((v, _, i) => checksumUnit(v, i), 1),
    "actual work independent of schedule",
  );
}
s = new Scheduler([job("A"), job("B")]);
const e = s.step();
e.ready.push("X");
e.boundary.push("X");
const snapshot = s.snapshot();
snapshot.trace[0].ready.push("Y");
ok(!JSON.stringify(s.snapshot()).includes("X"), "step detached");
ok(!JSON.stringify(s.snapshot()).includes("Y"), "snapshot detached");
ok(s.cancel("A"), "cancel running");
ok(!s.cancel("A"), "cancel idempotent");
ok(s.run().tasks[0].state === "canceled", "cancel retained");
s = new Scheduler([job("A"), job("B")], "rr", 1, {
  A: () => {
    throw Error("secret error");
  },
});
const failed = s.run();
ok(
  failed.tasks[0].state === "failed" && failed.tasks[1].state === "done",
  "callback failure isolation",
);
ok(
  !JSON.stringify(failed).includes("secret error"),
  "no callback exception disclosure",
);
for (const jobs of [
  null,
  {},
  [],
  [null],
  [job(), job()],
  [job("a")],
  [job("A\n")],
  [job("__proto__")],
  [job("A", true)],
  [job("A", 129)],
  [job("A", 0, [0])],
  [job("A", 0, [1, 2])],
  [job("A", 0, [1], 2 ** 32)],
  [{ ...job(), extra: 1 }],
]) {
  assert.throws(() => new Scheduler(jobs));
  checks++;
}
for (const out of [true, -1, 2 ** 32, null, "1"])
  ok(
    new Scheduler([job()], "rr", 2, { A: () => out }).run().tasks[0].state ===
      "failed",
    "bad callback value",
  );
for (const action of ["step", "cancel"]) {
  let runner;
  runner = new Scheduler([job("A"), job("B", 0, [1])], "rr", 2, {
    A: () => (action === "step" ? runner.step() : runner.cancel("A")),
  });
  const out = runner.run();
  ok(
    out.tasks[0].state === "failed" &&
      out.tasks[1].state === "done" &&
      out.now === 2,
    "reentrant " + action + " fails safely",
  );
}
for (const bad of [Array(1), [job("A\r")], [job("A", 0, Array(1))]]) {
  assert.throws(() => new Scheduler(bad));
  checks++;
}
let random = 123456;
const rand = (n) => {
  random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
  return random % n;
};
const cases = [];
for (let i = 0; i < 250; i++) {
  const jobs = Array.from({ length: 1 + rand(7) }, (_, j) =>
    job(
      String.fromCharCode(65 + j),
      rand(10),
      Array.from({ length: [1, 3, 5, 7][rand(4)] }, () => 1 + rand(8)),
      rand(0xffffffff),
    ),
  );
  for (const policy of ["fcfs", "rr", "sjf", "srtf"])
    cases.push({ jobs, policy, quantum: 1 + rand(8) });
}
cases.push(
  ...["fcfs", "rr", "sjf", "srtf"].map((policy) => ({
    jobs: [job("A", 128, [64, 64, 64, 64, 64, 64, 64], 0xffffffff)],
    policy,
    quantum: 32,
  })),
);
for (let i = 0; i < 100; i++) {
  const jobs = Array.from({ length: 5 }, (_, j) =>
    job(
      String.fromCharCode(65 + j),
      rand(8),
      [1 + rand(6), 1 + rand(4), 1 + rand(6)],
      rand(0xffffffff),
    ),
  );
  cases.push({
    jobs,
    policy: ["fcfs", "rr", "sjf", "srtf"][i % 4],
    quantum: 1 + rand(4),
    actions: [
      { steps: rand(6), cancel: "C" },
      { steps: rand(5), cancel: "A" },
    ],
  });
}
const py = spawnSync("python3", ["-m", "tests.parity"], {
  input: JSON.stringify(cases),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(py.status, 0, py.stderr);
const native = JSON.parse(py.stdout);
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  assert.deepEqual(
    (() => {
      const runner = new Scheduler(c.jobs, c.policy, c.quantum);
      for (const a of c.actions || []) {
        for (let j = 0; j < a.steps; j++) runner.step();
        runner.cancel(a.cancel);
      }
      return runner.run();
    })(),
    native[i],
    `full state parity case${i}`,
  );
  checks++;
}
console.log(
  JSON.stringify({
    checks,
    full_state_native_parity: cases.length,
    policies: 4,
    independent_native_oracle_cases: 1200,
  }),
);
