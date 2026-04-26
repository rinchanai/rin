import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const gui = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-gui", "web-assets.js"))
    .href
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
);
const guiMain = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-gui", "main.js")).href
);

test("GUI HTML escapes title and keeps the browser RPC endpoint local", () => {
  const html = gui.buildGuiHtml({ title: "<Rin & GUI>" });

  assert.match(html, /&lt;Rin &amp; GUI&gt;/);
  assert.match(html, /new WebSocket/);
  assert.match(html, /location\.host \+ '\/rpc'/);
  assert.doesNotMatch(html, /<Rin & GUI>/);
});

test("GUI args parse local host, ephemeral port, and browser opening switch", () => {
  assert.deepEqual(
    gui.parseRinGuiArgs(["gui", "--host", "0.0.0.0", "--port=0", "--no-open"]),
    {
      host: "0.0.0.0",
      port: 0,
      open: false,
      app: false,
    },
  );
  assert.deepEqual(
    gui.parseRinGuiArgs([
      "--host=localhost",
      "--port",
      "4317",
      "--open",
      "--app",
    ]),
    {
      host: "localhost",
      port: 4317,
      open: true,
      app: true,
    },
  );
  assert.throws(
    () => gui.parseRinGuiArgs(["--port", "70000"]),
    /rin_gui_invalid_port:70000/,
  );
});

test("GUI app-mode browser invocation uses desktop app windows", () => {
  assert.deepEqual(
    guiMain.buildOpenBrowserInvocation("http://127.0.0.1:1/", {
      app: true,
      platform: "win32",
    }),
    {
      command: "cmd",
      args: ["/c", "start", "", "msedge", "--app=http://127.0.0.1:1/"],
    },
  );
});

test("Windows default launch mode is GUI-first while other platforms keep TUI", () => {
  assert.equal(main.defaultLaunchModeForPlatform("win32"), "gui");
  assert.equal(main.defaultLaunchModeForPlatform("linux"), "tui");
  assert.equal(main.defaultLaunchModeForPlatform("darwin"), "tui");
});
