import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";
const root = resolve("docs");
const server = createServer(async (req, res) => {
  try {
    const p = resolve(
      root,
      "." +
        decodeURIComponent(
          new URL(req.url, "http://localhost").pathname.replace(
            /\/$/,
            "/index.html",
          ),
        ),
    );
    if (!p.startsWith(root + "/")) throw Error();
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      }[extname(p)] || "application/octet-stream",
    );
    res.end(await readFile(p));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base =
    process.env.CADENCEQ_URL || `http://127.0.0.1:${server.address().port}/`,
  shots = resolve(process.env.CADENCEQ_SHOTS || "build/screenshots");
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
let checks = 0;
const ok = (v, m) => {
  assert.ok(v, m);
  checks++;
};
const errors = [],
  failed = [],
  requests = [];
try {
  for (const width of [1440, 1024, 768, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 1080 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("request", (r) => requests.push(r.url()));
    page.on("requestfailed", (r) => failed.push(r.url()));
    await page.goto(base);
    await page.waitForSelector(".task-card");
    await page.screenshot({ path: resolve(shots, `top-${width}.png`) });
    await page.screenshot({
      path: resolve(shots, `full-${width}.png`),
      fullPage: true,
    });
    ok(
      (await page.locator("#clock").innerText()).startsWith("0"),
      "no automatic work",
    );
    await page.keyboard.press("Tab");
    ok(
      await page.locator(".skip").evaluate((e) => e === document.activeElement),
      "skip first",
    );
    await page.keyboard.press("Enter");
    ok(new URL(page.url()).hash === "#lab", "skip link");
    await page.locator("#step").click();
    ok(
      (await page.locator("#clock").innerText()).startsWith("1"),
      "one actual step",
    );
    ok(
      (await page.locator("#ledger").innerText()).includes("1 work"),
      "callback counted",
    );
    ok(
      (await page.locator("#live").innerText()).includes("A / work"),
      "selected A",
    );
    await page.locator("#finish").click();
    ok(
      (await page.locator("#clock").innerText()).startsWith("22"),
      "conserved work22",
    );
    ok(
      (await page.locator("#phase").innerText()) === "All tasks terminal",
      "finished",
    );
    ok(await page.locator("#step").isDisabled(), "finished disabled");
    const receipts = await page.locator(".receipt").allTextContents();
    ok(
      receipts.every((x) => /0x[0-9a-f]{8}/.test(x)),
      "real receipts",
    );
    await page.locator(".segment").first().click();
    ok(
      (await page.locator("#inspect").innerText()).includes("Work receipt:"),
      "inspect span",
    );
    await page.screenshot({ path: resolve(shots, `lab-${width}.png`) });
    await page.locator("#policy").selectOption("fcfs");
    ok(await page.locator("#finish").isDisabled(), "edits stale");
    ok(await page.locator("#stale").isVisible(), "stale notice");
    await page.locator("#apply").click();
    await page.locator("#finish").click();
    ok(
      JSON.stringify(await page.locator(".receipt").allTextContents()) ===
        JSON.stringify(receipts),
      "same actual result across policy",
    );
    for (const policy of ["sjf", "srtf"]) {
      await page.locator("#policy").selectOption(policy);
      await page.locator("#apply").click();
      await page.locator("#finish").click();
      ok(
        (await page.locator("#phase").innerText()) === "All tasks terminal",
        "all policies " + policy,
      );
    }
    await page.locator("#preset").selectOption("sleep");
    await page.locator("#policy").selectOption("rr");
    await page.locator("#apply").click();
    await page.locator("#step").click();
    await page.locator("#step").click();
    ok(
      (await page.locator("#sleepers").innerText()).includes("A until 6"),
      "real sleep schedule",
    );
    await page.locator("#cancel-task").selectOption("A");
    await page.locator("#cancel").click();
    ok(
      (await page.locator("#ledger").innerText()).includes("canceled"),
      "cancel sleeper",
    );
    await page.locator("#finish").click();
    ok(
      (await page.locator("#ledger").innerText()).includes(
        "partial, not rolled back",
      ),
      "cancel caveat",
    );
    await page.locator("#preset").selectOption("idle");
    await page.locator("#apply").click();
    await page.locator("#step").click();
    ok(
      (await page.locator("#live").innerText()).includes("idle / idle"),
      "idle does no callback",
    );
    await page.locator("#play").click();
    await page.waitForTimeout(390);
    await page.locator("#play").click();
    const frozen = await page.locator("#clock").innerText();
    await page.waitForTimeout(300);
    ok(
      (await page.locator("#clock").innerText()) === frozen,
      "pause stops timer",
    );
    await page.locator("#finish").click();
    ok(
      (await page.locator("#phase").innerText()) === "All tasks terminal",
      "idle workload complete",
    );
    await page.locator('[data-field="id"]').first().fill("<img>");
    await page.locator("#apply").click();
    ok(
      (await page.locator("#error").innerText()).includes("Unique task IDs"),
      "reject markup ID",
    );
    ok(await page.locator("#step").isDisabled(), "invalid cannot run");
    ok((await page.locator("#jobs img").count()) === 0, "no HTMLinjection");
    await page.locator('[data-field="id"]').first().fill("A");
    await page.locator('[data-field="bursts"]').first().fill("1 / 2");
    await page.locator("#apply").click();
    ok(
      (await page.locator("#error").innerText()).includes("alternate"),
      "reject even bursts",
    );
    await page.locator('[data-field="bursts"]').first().fill("1 / 2 / 1");
    await page.locator('[data-field="arrival"]').first().fill("1e2");
    await page.locator("#apply").click();
    ok(
      (await page.locator("#error").innerText()).includes("whole decimal"),
      "strict decimal",
    );
    await page.locator('[data-field="arrival"]').first().fill("0");
    await page.locator("#apply").click();
    ok(await page.locator("#step").isEnabled(), "recovery");
    const n = await page.locator(".job").count();
    await page.locator("#add").click();
    ok((await page.locator(".job").count()) === n + 1, "add task");
    await page
      .getByRole("button", { name: `Remove task ${n + 1}`, exact: true })
      .click();
    ok((await page.locator(".job").count()) === n, "remove task");
    if (width === 1440) {
      await page.locator("#preset").selectOption("convoy");
      while ((await page.locator(".job").count()) < 12)
        await page.locator("#add").click();
      for (const input of await page.locator('[data-field="arrival"]').all())
        await input.fill("0");
      for (const input of await page.locator('[data-field="bursts"]').all())
        await input.fill("64 / 1 / 64 / 1 / 64 / 1 / 64");
      await page.locator("#policy").selectOption("rr");
      await page.locator("#quantum").fill("1");
      await page.locator("#quantum").dispatchEvent("input");
      await page.locator("#apply").click();
      await page.locator("#finish").click();
      ok(
        (await page.locator("#phase").innerText()) === "All tasks terminal",
        "maximum12-task work executes",
      );
      ok(
        (await page.locator("#clock").innerText()).startsWith("3072"),
        "3072 actual callback units",
      );
      ok((await page.locator(".task-card").count()) === 12, "all12 results");
      ok(await page.locator("#add").isDisabled(), "task limit enforced");
      await page.locator("#preset").selectOption("convoy");
      await page.locator("#apply").click();
    }
    for (const sel of [
      "#step",
      "#play",
      "#finish",
      "#apply",
      "#add",
      "#cancel",
      "#policy",
      "#preset",
    ])
      ok(
        await page
          .locator(sel)
          .evaluate((e) => e.getBoundingClientRect().height >= 44),
        "touch height " + sel,
      );
    ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "no page overflow",
    );
    ok(
      await page.evaluate(
        () => localStorage.length === 0 && sessionStorage.length === 0,
      ),
      "no persistence",
    );
    await page.screenshot({ path: resolve(shots, `final-${width}.png`) });
    await page.close();
  }
  ok(errors.length === 0, JSON.stringify(errors));
  ok(failed.length === 0, JSON.stringify(failed));
  ok(
    requests.every((x) => new URL(x).origin === new URL(base).origin),
    "no external requests",
  );
  console.log(
    JSON.stringify({
      checks,
      widths: [1440, 1024, 768, 390, 320],
      errors,
      failed,
      third_party: 0,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
