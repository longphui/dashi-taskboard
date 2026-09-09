import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function fixtureHtml() {
  const encodedSource = Buffer.from(source).toString("base64");
  return `<!doctype html>
<html lang="zh-CN">
  <body>
    <aside>
      <nav role="navigation">
        <div data-app-action-sidebar-scroll>
          <div>
            <div class="contents"><button><span>拉取请求</span></button></div>
            <div class="contents"><button><span>站点</span></button></div>
            <div class="contents"><button><span>已安排</span></button></div>
            <div class="contents"><button><svg></svg><span class="text-fade-truncate">插件</span></button></div>
          </div>
          <section data-app-action-sidebar-section></section>
        </div>
      </nav>
    </aside>
    <output id="result"></output>
    <script>
      window.__CODEX_TASKBOARD_SOURCE_HASH__ = "wrapped-sidebar-entry";
      eval(new TextDecoder().decode(Uint8Array.from(
        atob(${JSON.stringify(encodedSource)}),
        (character) => character.charCodeAt(0),
      )));
      requestAnimationFrame(() => {
        document.getElementById("result").textContent = document.getElementById("codex-taskboard-entry")
          ? "mounted"
          : "missing";
        window.__codexTaskboardInjection__?.destroy();
      });
    </script>
  </body>
</html>`;
}

test("Taskboard mounts beside wrapped native sidebar buttons", async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((_request, response) => {
    response.setHeader("connection", "close");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const profile = await mkdtemp(path.join(os.tmpdir(), "taskboard-sidebar-entry-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=1000",
    "--dump-dom",
    `http://127.0.0.1:${server.address().port}/fixture`,
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 });

  assert.match(stdout, /<output id="result">mounted<\/output>/);
});
