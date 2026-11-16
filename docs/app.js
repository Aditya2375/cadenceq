import { Scheduler } from "./core.js";
const $ = (s) => document.querySelector(s),
  colors = [
    "#c7b7de",
    "#e5d39d",
    "#b8cdbf",
    "#c5d6e4",
    "#e5bec0",
    "#c5ce9f",
    "#d2c0a9",
    "#b8cbd8",
    "#c8c1df",
    "#dac5c3",
    "#c7d0c1",
    "#d7c3a2",
  ];
const J = (id, arrival, bursts, seed = 1) => ({ id, arrival, bursts, seed });
const presets = {
  convoy: [
    J("A", 0, [12], 11),
    J("B", 1, [3], 22),
    J("C", 2, [2], 33),
    J("D", 3, [5], 44),
  ],
  sleep: [
    J("A", 0, [2, 4, 3], 10),
    J("B", 0, [7], 20),
    J("C", 2, [1, 2, 2], 30),
    J("D", 5, [2], 40),
  ],
  boundary: [J("A", 0, [5], 1), J("B", 2, [2], 2), J("C", 2, [1], 3)],
  idle: [J("A", 3, [2, 4, 2], 7), J("B", 7, [2], 8)],
};
const notes = {
  fcfs: "Non-preemptive current burst. Oldest ready task first.",
  rr: "Fixed quantum, FIFO queue. Boundary arrivals precede requeue.",
  sjf: "Shortest known current burst. Non-preemptive once selected.",
  srtf: "Shortest remaining current burst at each callback boundary. Current wins ties.",
};
let scheduler = null,
  timer = null,
  dirty = false,
  selected = null,
  applied = [];
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  $("#play").textContent = "Play ▶";
}
function markDirty() {
  stop();
  dirty = true;
  $("#stale").hidden = false;
  $("#error").textContent = "";
  sync();
}
function inputs(row, index) {
  const card = el("div", undefined, "job");
  card.style.setProperty("--task", colors[index]);
  const head = el("div", undefined, "job-header");
  head.append(el("span", `TASK ${String(index + 1).padStart(2, "0")}`));
  const remove = el("button", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove task ${index + 1}`);
  remove.addEventListener("click", () => {
    if ($("#jobs").children.length === 1) {
      $("#error").textContent = "Keep at least one task.";
      return;
    }
    card.remove();
    renumber();
    markDirty();
  });
  head.append(remove);
  card.append(head);
  const fields = el("div", undefined, "job-fields");
  for (const [key, label, value] of [
    ["id", "ID", row.id],
    ["arrival", "Arrival", row.arrival],
    ["bursts", "CPU / sleep", row.bursts.join(" / ")],
    ["seed", "Work seed", row.seed],
  ]) {
    const wrap = el("div");
    const id = `job-${index}-${key}`;
    const lab = el("label", label);
    lab.htmlFor = id;
    const input = el("input");
    input.id = id;
    input.dataset.field = key;
    input.value = String(value);
    input.maxLength = key === "bursts" ? 40 : key === "id" ? 8 : 10;
    input.autocomplete = "off";
    input.spellcheck = false;
    if (key !== "id" && key !== "bursts") input.inputMode = "numeric";
    input.addEventListener("input", markDirty);
    wrap.append(lab, input);
    fields.append(wrap);
  }
  card.append(fields);
  return card;
}
function renumber() {
  [...$("#jobs").children].forEach((card, index) => {
    card.style.setProperty("--task", colors[index]);
    card.querySelector(".job-header span").textContent =
      `TASK ${String(index + 1).padStart(2, "0")}`;
    card
      .querySelector("button")
      .setAttribute("aria-label", `Remove task ${index + 1}`);
    for (const input of card.querySelectorAll("input")) {
      const id = `job-${index}-${input.dataset.field}`;
      input.id = id;
      input.previousElementSibling.htmlFor = id;
    }
  });
  $("#job-count").textContent = `${$("#jobs").children.length} TASKS`;
  $("#add").disabled = $("#jobs").children.length >= 12;
}
function fill(rows) {
  $("#jobs").replaceChildren(...rows.map(inputs));
  renumber();
}
function parseInteger(text) {
  if (!/^\d+$/.test(text))
    throw Error(
      "Use whole decimal numbers, not blank, signed or fractional values.",
    );
  return Number(text);
}
function read() {
  return [...$("#jobs").children].map((card) => {
    const value = (key) => card.querySelector(`[data-field="${key}"]`).value;
    const bursts = value("bursts")
      .split("/")
      .map((x) => parseInteger(x.trim()));
    return {
      id: value("id").trim(),
      arrival: parseInteger(value("arrival").trim()),
      bursts,
      seed: parseInteger(value("seed").trim()),
    };
  });
}
function apply() {
  stop();
  try {
    const rows = read();
    const next = new Scheduler(
      rows,
      $("#policy").value,
      Number($("#quantum").value),
    );
    scheduler = next;
    applied = structuredClone(rows);
    dirty = false;
    selected = null;
    $("#error").textContent = "";
    $("#stale").hidden = true;
    render();
  } catch (error) {
    dirty = true;
    $("#stale").hidden = false;
    $("#error").textContent = error.message;
    sync();
  }
}
function sync() {
  const complete = !scheduler || scheduler.complete;
  for (const id of ["step", "play", "finish"])
    $("#" + id).disabled = dirty || complete;
  $("#cancel").disabled = dirty || complete || !$("#cancel-task").value;
  $("#cancel-task").disabled = dirty || complete;
  $("#quantum").disabled = $("#policy").value !== "rr";
  $("#quantum-label").textContent = `${$("#quantum").value} ticks`;
  $("#policy-note").textContent = notes[$("#policy").value];
}
function badge(id) {
  const b = el("span", id, "task-badge");
  b.style.setProperty("--task", colors[applied.findIndex((x) => x.id === id)]);
  return b;
}
function inspect(event) {
  selected = event.start;
  $("#inspect-title").textContent =
    `[${event.start}, ${event.end}) / ${event.task ?? "IDLE"}`;
  $("#inspect").textContent = event.task
    ? `Outcome: ${event.outcome}. Waiting at selection: ${event.ready.join(", ") || "none"}. Boundary arrivals/wakes: ${event.boundary.join(", ") || "none"}. Work receipt: 0x${event.value === null ? "--------" : event.value.toString(16).padStart(8, "0")}.`
    : `No task was ready. No callback ran. Boundary arrivals/wakes: ${event.boundary.join(", ") || "none"}.`;
  for (const b of document.querySelectorAll(".segment"))
    b.setAttribute(
      "aria-pressed",
      Number(b.dataset.last) === selected ? "true" : "false",
    );
}
function timeline(out) {
  const root = $("#timeline");
  root.replaceChildren();
  const horizon = Math.max(16, out.now),
    axis = el("div", undefined, "axis");
  axis.append(el("span", "0"), el("span", `${horizon} ticks`));
  root.append(axis);
  const merged = [];
  for (const e of out.trace) {
    const last = merged.at(-1);
    if (last && last.task === e.task && last.end === e.start) {
      last.end = e.end;
      last.last = e;
    } else merged.push({ task: e.task, start: e.start, end: e.end, last: e });
  }
  for (const id of [...applied.map((x) => x.id), null]) {
    const row = el("div", undefined, "timeline-row");
    row.append(el("b", id ?? "idle"));
    const track = el("div", undefined, "track");
    for (const span of merged.filter((x) => x.task === id)) {
      const b = el(
        "button",
        String(span.end - span.start),
        "segment" + (id === null ? " idle" : ""),
      );
      b.type = "button";
      b.style.left = (span.start / horizon) * 100 + "%";
      b.style.width = ((span.end - span.start) / horizon) * 100 + "%";
      b.style.setProperty(
        "--task",
        id === null ? "#ddd" : colors[applied.findIndex((x) => x.id === id)],
      );
      b.dataset.last = span.last.start;
      b.setAttribute(
        "aria-label",
        `${id ?? "idle"} ticks ${span.start} to ${span.end}, inspect tick ${span.last.start}`,
      );
      b.setAttribute("aria-pressed", String(span.last.start === selected));
      b.addEventListener("click", () => inspect(span.last));
      track.append(b);
    }
    row.append(track);
    root.append(row);
  }
  $("#trace-label").textContent = out.now
    ? `0 → ${out.now} / ${merged.length} spans`
    : "No elapsed ticks";
  if (selected !== null && out.trace[selected]) inspect(out.trace[selected]);
  else {
    $("#inspect-title").textContent = "Awaiting the first tick";
    $("#inspect").textContent =
      "Step the scheduler to inspect a scheduling decision.";
  }
}
function render() {
  if (!scheduler) return;
  const out = scheduler.snapshot(),
    done = out.tasks.filter((t) => t.state === "done");
  $("#clock").replaceChildren(
    document.createTextNode(out.now),
    el("span", " ticks"),
  );
  $("#wait").replaceChildren(
    document.createTextNode(
      (out.tasks.reduce((a, t) => a + t.wait, 0) / out.tasks.length).toFixed(1),
    ),
    el("span", " ticks"),
  );
  $("#turnaround").replaceChildren(
    document.createTextNode(
      done.length
        ? (done.reduce((a, t) => a + t.turnaround, 0) / done.length).toFixed(1)
        : "-",
    ),
    ...(done.length ? [el("span", " ticks")] : []),
  );
  const work = out.trace.filter((e) => e.task !== null).length;
  $("#busy").replaceChildren(
    document.createTextNode(
      out.now ? ((100 * work) / out.now).toFixed(0) : "0",
    ),
    el("span", "%"),
  );
  $("#phase").textContent = out.complete
    ? "All tasks terminal"
    : timer !== null
      ? "Taking turns"
      : "Ready to dispatch";
  const event = out.trace.at(-1);
  $("#live").textContent = event
    ? `Tick ${event.start} → ${event.end}: ${event.task ?? "idle"} / ${event.outcome}. ${done.length} of ${out.tasks.length} completed.`
    : "No work has run yet.";
  const queue = $("#queue");
  queue.replaceChildren();
  const order = [
    ...(scheduler.current !== null ? [scheduler.current] : []),
    ...(["sjf", "srtf"].includes(scheduler.policy)
      ? [...scheduler.ready].sort(
          (a, b) =>
            scheduler.tasks[a].remaining - scheduler.tasks[b].remaining ||
            scheduler.tasks[a].ticket - scheduler.tasks[b].ticket,
        )
      : scheduler.ready),
  ];
  for (const i of order) {
    const t = scheduler.tasks[i],
      b = el("span", `${t.name} · ${t.remaining}`, "task-chip");
    b.style.setProperty("--task", colors[i]);
    queue.append(b);
  }
  if (!order.length)
    queue.append(
      el(
        "span",
        out.complete
          ? "No runnable tasks."
          : "Empty until an arrival or wakeup.",
        "empty",
      ),
    );
  $("#sleepers").textContent =
    "Sleeping: " +
    (out.tasks
      .filter((t) => t.state === "sleeping")
      .map((t) => `${t.id} until ${t.wake}`)
      .join(" · ") || "none") +
    " / New: " +
    (scheduler.tasks
      .filter((t) => t.state === "new")
      .map((t) => `${t.name} at ${t.arrival}`)
      .join(" · ") || "none");
  const old = $("#cancel-task").value;
  $("#cancel-task").replaceChildren();
  for (const t of out.tasks.filter(
    (t) => !["done", "failed", "canceled"].includes(t.state),
  )) {
    const option = el("option", t.id);
    option.value = t.id;
    $("#cancel-task").append(option);
  }
  if ([...$("#cancel-task").options].some((x) => x.value === old))
    $("#cancel-task").value = old;
  const ledger = $("#ledger");
  ledger.replaceChildren();
  for (const t of out.tasks) {
    const card = el("div", undefined, "task-card"),
      identity = el("div", undefined, "identity");
    const desc = el("div");
    desc.append(
      el("strong", t.state),
      el("small", `${t.cpu} work / ${t.wait} wait`),
    );
    identity.append(badge(t.id), desc);
    const metrics = el("div");
    metrics.append(
      el(
        "strong",
        `Response ${t.response ?? "-"} / turn ${t.turnaround ?? "-"}`,
      ),
      el("small", `start ${t.first ?? "-"} · end ${t.finished ?? "-"}`),
    );
    const receipt = el(
      "div",
      `0x${t.value.toString(16).padStart(8, "0")}`,
      "receipt",
    );
    receipt.append(
      el(
        "small",
        t.state === "canceled"
          ? "partial, not rolled back"
          : t.state === "done"
            ? "completed work receipt"
            : "partial work receipt",
      ),
    );
    card.append(identity, metrics, receipt);
    ledger.append(card);
  }
  timeline(out);
  sync();
}
function step() {
  if (dirty || !scheduler || scheduler.complete) return;
  const event = scheduler.step();
  if (event) selected = event.start;
  if (scheduler.complete) stop();
  render();
}
$("#step").addEventListener("click", step);
$("#play").addEventListener("click", () => {
  if (timer !== null) {
    stop();
    render();
    return;
  }
  if (dirty || scheduler.complete) return;
  timer = setInterval(step, 180);
  $("#play").textContent = "Pause Ⅱ";
  render();
});
$("#finish").addEventListener("click", () => {
  if (dirty) return;
  stop();
  scheduler.run();
  selected = scheduler.now ? scheduler.now - 1 : null;
  render();
});
$("#apply").addEventListener("click", apply);
$("#preset").addEventListener("change", () => {
  fill(presets[$("#preset").value]);
  markDirty();
});
$("#policy").addEventListener("change", markDirty);
$("#quantum").addEventListener("input", markDirty);
$("#add").addEventListener("click", () => {
  if ($("#jobs").children.length >= 12) return;
  const names = new Set(
    [...$("#jobs").querySelectorAll('[data-field="id"]')].map((x) => x.value),
  );
  let id = "A";
  for (let i = 0; names.has(id); i++) id = String.fromCharCode(66 + i);
  $("#jobs").append(inputs(J(id, 0, [3], 1), $("#jobs").children.length));
  renumber();
  markDirty();
});
$("#cancel").addEventListener("click", () => {
  if (dirty || !$("#cancel-task").value) return;
  stop();
  scheduler.cancel($("#cancel-task").value);
  render();
});
$("#cancel-task").addEventListener("change", sync);
window.addEventListener("pagehide", stop);
fill(presets.convoy);
apply();
