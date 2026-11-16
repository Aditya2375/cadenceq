import copy, json, random, subprocess, sys, unittest
from cadenceq import Scheduler, checksum_unit


def job(name="A", arrival=0, bursts=None, seed=1):
    return {"id": name, "arrival": arrival, "bursts": bursts or [3], "seed": seed}


def oracle(jobs, policy, quantum):
    """Independent scan/table oracle. No production queue/core helpers/checksum calls."""
    states = [
        dict(
            x,
            phase=0,
            left=x["bursts"][0],
            state="new",
            wake=None,
            first=None,
            end=None,
            cpu=0,
            wait=0,
            rank=0,
        )
        for x in jobs
    ]
    clock = 0
    ticket = 0
    current = None
    used = 0
    timeline = []
    while not all(s["state"] == "done" for s in states):
        for s in states:
            if (s["state"] == "new" and s["arrival"] <= clock) or (
                s["state"] == "sleeping" and s["wake"] <= clock
            ):
                s["state"] = "ready"
                s["rank"] = ticket
                ticket += 1
        candidates = [i for i, s in enumerate(states) if s["state"] == "ready"]
        if (
            current is not None
            and policy == "srtf"
            and candidates
            and min(states[i]["left"] for i in candidates) < states[current]["left"]
        ):
            states[current]["state"] = "ready"
            states[current]["rank"] = ticket
            ticket += 1
            current = None
        candidates = [i for i, s in enumerate(states) if s["state"] == "ready"]
        if current is None and candidates:
            key = (
                (lambda i: (states[i]["left"], states[i]["rank"]))
                if policy in ("sjf", "srtf")
                else (lambda i: states[i]["rank"])
            )
            current = min(candidates, key=key)
            used = 0
            states[current]["state"] = "running"
        for s in states:
            if s["state"] == "ready":
                s["wait"] += 1
        timeline.append(states[current]["id"] if current is not None else None)
        if current is not None:
            s = states[current]
            s["first"] = clock if s["first"] is None else s["first"]
            s["left"] -= 1
            s["cpu"] += 1
            used += 1
            if s["left"] == 0:
                if s["phase"] + 1 == len(s["bursts"]):
                    s["state"] = "done"
                    s["end"] = clock + 1
                else:
                    s["state"] = "sleeping"
                    s["wake"] = clock + 1 + s["bursts"][s["phase"] + 1]
                    s["phase"] += 2
                    s["left"] = s["bursts"][s["phase"]]
                current = None
        clock += 1
        # Boundary events occur before RR reinsertion, across both event types.
        for s in states:
            if (s["state"] == "new" and s["arrival"] <= clock) or (
                s["state"] == "sleeping" and s["wake"] <= clock
            ):
                s["state"] = "ready"
                s["rank"] = ticket
                ticket += 1
        if current is not None and policy == "rr" and used == quantum:
            states[current]["state"] = "ready"
            states[current]["rank"] = ticket
            ticket += 1
            current = None
    return timeline, [
        {
            k: s[v]
            for k, v in [
                ("id", "id"),
                ("cpu", "cpu"),
                ("wait", "wait"),
                ("first", "first"),
                ("finished", "end"),
            ]
        }
        for s in states
    ]


class Behavior(unittest.TestCase):
    def test_fcfs_fixture(self):
        out = Scheduler(
            [job("A", 0, [5]), job("B", 1, [2]), job("C", 2, [1])], "fcfs"
        ).run()
        self.assertEqual([e["task"] for e in out["trace"]], list("AAAAABBC"))
        self.assertEqual([r["wait"] for r in out["tasks"]], [0, 4, 5])
        self.assertEqual([r["turnaround"] for r in out["tasks"]], [5, 6, 6])

    def test_srtf_fixture(self):
        o = Scheduler(
            [job("A", 0, [5]), job("B", 1, [2]), job("C", 2, [1])], "srtf"
        ).run()
        self.assertEqual([e["task"] for e in o["trace"]], list("ABBCAAAA"))

    def test_sjf_nonpreemptive(self):
        self.assertEqual(
            [
                x["task"]
                for x in Scheduler([job("A", 0, [5]), job("B", 1, [1])], "sjf").run()[
                    "trace"
                ]
            ],
            list("AAAAAB"),
        )

    def test_srtf_tie_keeps_current(self):
        self.assertEqual(
            [
                x["task"]
                for x in Scheduler([job("A", 0, [3]), job("B", 1, [2])], "srtf").run()[
                    "trace"
                ]
            ],
            list("AAABB"),
        )

    def test_rr_boundary_admit_before_requeue(self):
        self.assertEqual(
            [
                x["task"]
                for x in Scheduler([job("A", 0, [3]), job("B", 2, [1])], "rr", 2).run()[
                    "trace"
                ]
            ],
            list("AABA"),
        )

    def test_sleep_and_idle(self):
        out = Scheduler([job("A", 2, [1, 2, 1])]).run()
        self.assertEqual(
            [x["task"] for x in out["trace"]], [None, None, "A", None, None, "A"]
        )
        a = out["tasks"][0]
        self.assertEqual(
            (a["cpu"], a["wait"], a["response"], a["turnaround"]), (2, 0, 0, 4)
        )

    def test_sleep_releases_fcfs(self):
        self.assertEqual(
            [
                x["task"]
                for x in Scheduler(
                    [job("A", 0, [1, 2, 1]), job("B", 0, [4])], "fcfs"
                ).run()["trace"]
            ],
            list("ABBBBA"),
        )

    def test_actual_callbacks_not_trace_only(self):
        called = []

        def cb(name):
            def work(value, index):
                called.append((name, index, value))
                return value + 10

            return work

        out = Scheduler(
            [job("A", 0, [2]), job("B", 0, [2])], "rr", 1, {"A": cb("A"), "B": cb("B")}
        ).run()
        self.assertEqual(called, [("A", 0, 1), ("B", 0, 1), ("A", 1, 11), ("B", 1, 11)])
        self.assertEqual([x["value"] for x in out["tasks"]], [21, 21])

    def test_failed_callback_isolated_and_no_retry(self):
        count = []

        def fail(v, n):
            count.append(n)
            raise RuntimeError("private message never emitted")

        o = Scheduler([job("A"), job("B", 0, [1])], callbacks={"A": fail}).run()
        self.assertEqual(count, [0])
        self.assertEqual([x["state"] for x in o["tasks"]], ["failed", "done"])
        self.assertEqual(o["tasks"][0]["error"], "Work callback failed")
        self.assertNotIn("private message", json.dumps(o))
        self.assertEqual(o["trace"][0]["outcome"], "failed")

    def test_invalid_callback_output_fails(self):
        for value in [True, -1, 2**32, None, "1"]:
            with self.subTest(value=value):
                self.assertEqual(
                    Scheduler([job()], callbacks={"A": lambda v, n: value}).run()[
                        "tasks"
                    ][0]["state"],
                    "failed",
                )

    def test_cancel_new_ready_running_sleeping(self):
        for steps in [0, 1, 2]:
            s = Scheduler([job("A", 0, [1, 2, 2]), job("B", 0, [6])])
            [s.step() for _ in range(steps)]
            self.assertTrue(s.cancel("A"))
            self.assertFalse(s.cancel("A"))
            o = s.run()
            self.assertEqual(o["tasks"][0]["state"], "canceled")
            self.assertTrue(all(e["task"] != "A" for e in o["trace"][steps:]))
        s = Scheduler([job("A", 0, [5])], quantum=4)
        s.step()
        self.assertEqual(s.snapshot()["tasks"][0]["state"], "running")
        s.cancel("A")
        self.assertTrue(s.complete)

    def test_cancel_ready_and_cancel_all_before_arrival(self):
        s = Scheduler([job("A", 0, [5]), job("B", 0, [2])], quantum=2)
        s.step()
        self.assertEqual(s.tasks[1].state, "ready")
        self.assertTrue(s.cancel("B"))
        self.assertEqual(s.run()["tasks"][1]["cpu"], 0)
        s = Scheduler([job("A", 10, [1]), job("B", 20, [1])])
        s.cancel("A")
        s.cancel("B")
        self.assertEqual(s.run()["now"], 0)
        self.assertIsNone(s.snapshot()["tasks"][0]["turnaround"])

    def test_joint_wake_arrival_input_order_before_requeue(self):
        o = Scheduler(
            [job("A", 0, [1, 1, 1]), job("B", 2, [1]), job("C", 0, [3])], "rr", 1
        ).run()
        self.assertEqual([e["task"] for e in o["trace"]], list("ACABCC"))
        self.assertEqual(o["trace"][1]["boundary"], ["A", "B"])

    def test_cancel_noop_done_and_unknown(self):
        s = Scheduler([job()])
        s.run()
        self.assertFalse(s.cancel("A"))
        with self.assertRaises(ValueError):
            s.cancel("MISSING")

    def test_snapshot_and_step_detached(self):
        s = Scheduler([job("A"), job("B")])
        event = s.step()
        event["ready"].append("X")
        event["boundary"].append("Y")
        out = s.snapshot()
        out["trace"][0]["ready"].append("Z")
        out["tasks"][0]["value"] = 8
        self.assertNotIn("X", str(s.snapshot()))
        self.assertNotIn("Y", str(s.snapshot()))
        self.assertNotIn("Z", str(s.snapshot()))
        self.assertEqual(s.tasks[0].value, checksum_unit(1, 0))

    def test_input_copied(self):
        jobs = [job()]
        s = Scheduler(jobs)
        jobs[0]["bursts"][0] = 64
        jobs[0]["id"] = "OTHER"
        self.assertEqual(s.run()["tasks"][0]["cpu"], 3)

    def test_complete_step_noop(self):
        s = Scheduler([job()])
        s.run()
        before = s.snapshot()
        self.assertIsNone(s.step())
        self.assertEqual(before, s.snapshot())

    def test_callback_reentrancy_fails_without_corrupting(self):
        for action in ["step", "cancel"]:
            s = None

            def work(v, n):
                return s.step() if action == "step" else s.cancel("A")

            s = Scheduler([job("A"), job("B", 0, [1])], callbacks={"A": work})
            out = s.run()
            self.assertEqual([t["state"] for t in out["tasks"]], ["failed", "done"])
            self.assertEqual(out["now"], 2)

    def test_policy_results_invariant(self):
        jobs = [job("A", 0, [4, 3, 5], 2**32 - 1), job("B", 1, [2, 4, 2], 0)]
        results = []
        for p in ["fcfs", "rr", "sjf", "srtf"]:
            results.append([r["value"] for r in Scheduler(jobs, p).run()["tasks"]])
        self.assertTrue(all(x == results[0] for x in results))

    def test_scan_oracle_random(self):
        rng = random.Random(1234)
        for case in range(300):
            jobs = [
                job(
                    chr(65 + i),
                    rng.randrange(8),
                    [rng.randrange(1, 6) for _ in range(rng.choice([1, 3, 5]))],
                    rng.randrange(2**32),
                )
                for i in range(rng.randrange(1, 7))
            ]
            for policy in ["fcfs", "rr", "sjf", "srtf"]:
                q = rng.randrange(1, 5)
                timeline, rows = oracle(jobs, policy, q)
                o = Scheduler(jobs, policy, q).run()
                self.assertEqual(
                    [x["task"] for x in o["trace"]], timeline, (case, policy)
                )
                self.assertEqual(
                    [
                        {k: r[k] for k in ["id", "cpu", "wait", "first", "finished"]}
                        for r in o["tasks"]
                    ],
                    rows,
                )

    def test_conservation_and_sleep_wait(self):
        o = Scheduler([job("A", 0, [3, 4, 2]), job("B", 2, [2, 1, 3])], "rr", 1).run()
        for i, t in enumerate(o["tasks"]):
            self.assertEqual(
                t["turnaround"],
                t["cpu"]
                + t["wait"]
                + sum([3, 4, 2][1::2] if i == 0 else [2, 1, 3][1::2]),
            )
        self.assertEqual(o["now"], len(o["trace"]))
        self.assertEqual(
            sum(t["cpu"] for t in o["tasks"]),
            sum(e["task"] is not None for e in o["trace"]),
        )


class Validation(unittest.TestCase):
    def test_schema(self):
        for val in [
            None,
            {},
            [],
            [1],
            [{"id": "A"}],
            [dict(job(), extra=1)],
            [job(), job()],
        ]:
            with self.subTest(val=val), self.assertRaises(ValueError):
                Scheduler(val)

    def test_id(self):
        for val in ["a", "<script>", "", 12, "A12345678", "A\n", "A B", "__proto__"]:
            with self.subTest(val=val), self.assertRaises(ValueError):
                Scheduler([job(val)])

    def test_integer_and_bounds(self):
        for field, values in [
            ("arrival", [True, -1, 129, 1.5, "1"]),
            ("seed", [False, -1, 2**32, None]),
        ]:
            for v in values:
                row = job()
                row[field] = v
                with self.subTest(field=field, v=v), self.assertRaises(ValueError):
                    Scheduler([row])
        for v in [0, 33, True, 2.5]:
            with self.assertRaises(ValueError):
                Scheduler([job()], quantum=v)
        for v in [None, "bad", 1]:
            with self.assertRaises(ValueError):
                Scheduler([job()], policy=v)

    def test_bursts(self):
        for v in [[], [0], [-1], [65], [True], [1, 2], [1] * 9, "1", None]:
            row = job()
            row["bursts"] = v
            with self.subTest(v=v), self.assertRaises(ValueError):
                Scheduler([row])

    def test_limits(self):
        with self.assertRaises(ValueError):
            Scheduler([job("A" + str(i)) for i in range(13)])
        with self.assertRaises(ValueError):
            Scheduler([job("A" + str(i), 128, [64] * 7) for i in range(12)])
        self.assertEqual(
            Scheduler([job("A", 128, [64] * 7)]).run()["tasks"][0]["cpu"], 256
        )

    def test_callbacks(self):
        for callbacks in [[], {"X": lambda v, n: 0}, {"A": None}]:
            with self.assertRaises(ValueError):
                Scheduler([job()], callbacks=callbacks)

    def test_cli(self):
        p = subprocess.run(
            [sys.executable, "-m", "cadenceq", "--policy", "rr"],
            input=json.dumps([job()]).encode(),
            capture_output=True,
        )
        self.assertEqual(p.returncode, 0)
        self.assertTrue(json.loads(p.stdout)["complete"])

    def test_cli_rejections(self):
        for raw in [b"bad", b"x" * 16385, b"\xff", b"[" * 2000]:
            p = subprocess.run(
                [sys.executable, "-m", "cadenceq"], input=raw, capture_output=True
            )
            self.assertEqual(p.returncode, 2)
            self.assertEqual(p.stdout, b"")
            self.assertIn("error", json.loads(p.stderr))


if __name__ == "__main__":
    unittest.main()
