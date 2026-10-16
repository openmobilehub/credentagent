// Evidence capture for the issue agent — screenshots and video of a real browser, via Playwright.
//
// The evidence agent writes a small script that imports this module BY ABSOLUTE PATH (its script
// lives in the run directory, outside this package, so it can't resolve `playwright` itself):
//
//   import { session, startServer } from "/abs/path/ci/issue-agent/capture.mjs";
//   const server = await startServer({ cwd: AFTER_DIR, cmd: "node examples/storefront.mjs", port: 4105 });
//   const s = await session({ outDir: EVIDENCE_DIR, name: "after-checkout", side: "after" });
//   await s.page.goto(`${server.url}/checkout?order=…`);
//   await s.shot("The checkout page shows the escaped cart value as text");
//   await s.close();          // finalizes the video
//   await server.stop();
//
// Every shot and video lands in EVIDENCE_DIR with a caption in manifest.json, which the report
// and the PR body are built from — so nothing reaches the PR without a caption saying what it shows.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VIEWPORT = { width: 1280, height: 800 };

async function addToManifest(outDir, entry) {
  const file = join(outDir, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
  manifest.push({ ...entry, at: new Date().toISOString() });
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

/**
 * Open a recorded browser session. `side` is "before" (main) or "after" (the fix) — the report
 * pairs them. Returns { page, context, shot(caption), close() }.
 */
export async function session({ outDir, name, side = "after", video = true }) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`session name must be kebab-case: ${name}`);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(video ? { recordVideo: { dir: join(outDir, `.video-${name}`), size: VIEWPORT } } : {}),
  });
  const page = await context.newPage();
  // Surface what the page does — a dialog (e.g. an injected alert) is evidence, so log it, then dismiss.
  const events = [];
  page.on("dialog", async (d) => {
    events.push({ type: "dialog", kind: d.type(), message: d.message() });
    await d.dismiss();
  });
  page.on("pageerror", (e) => events.push({ type: "pageerror", message: String(e) }));
  let n = 0;
  return {
    page,
    context,
    events,
    async shot(caption, { fullPage = true } = {}) {
      const file = `${name}-${String(++n).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage });
      await addToManifest(outDir, { kind: "image", file, caption, side, session: name, url: page.url() });
      return file;
    },
    async close(caption) {
      const v = page.video();
      await context.close();
      await browser.close();
      await addToManifest(outDir, { kind: "events", session: name, side, events });
      if (v) {
        const file = `${name}.webm`;
        await rename(await v.path(), join(outDir, file));
        await rm(join(outDir, `.video-${name}`), { recursive: true, force: true });
        await addToManifest(outDir, { kind: "video", file, caption: caption ?? `${side}: ${name}`, side, session: name });
      }
    },
  };
}

/**
 * Start a server from a checkout (`cwd`) and wait until `readyPath` answers. The command runs with
 * PORT set; `stop()` kills it. Output goes to <outDir>/server-<port>.log when outDir is given.
 */
export async function startServer({ cwd, cmd, port, readyPath = "/", env = {}, outDir, timeoutMs = 30_000 }) {
  const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, PORT: String(port), ...env }, detached: true });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${log.join("")}`);
    try {
      await fetch(url + readyPath);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server not ready on ${url} after ${timeoutMs}ms:\n${log.join("")}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    url,
    log,
    async stop() {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      if (outDir) await writeFile(join(outDir, `server-${port}.log`), log.join(""));
    },
  };
}

/** Render an HTML string in a recorded session — used for test-proof pages on non-UI issues. */
export async function renderHtml({ outDir, name, html, caption, side = "proof" }) {
  const s = await session({ outDir, name, side });
  await s.page.setContent(html, { waitUntil: "load" });
  await s.page.waitForTimeout(800);
  await s.shot(caption);
  // Scroll slowly so the video walks through the whole page.
  const height = await s.page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 300) {
    await s.page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" }), y);
    await s.page.waitForTimeout(350);
  }
  await s.page.waitForTimeout(600);
  await s.close(caption);
}
