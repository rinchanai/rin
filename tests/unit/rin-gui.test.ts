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
const nativeDesktop = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-gui", "native-desktop.js"),
  ).href
);

test("GUI args keep the native desktop surface and reject browser fallback switches", () => {
  assert.deepEqual(gui.parseRinGuiArgs(["gui", "--native"]), {});
  assert.deepEqual(gui.parseRinGuiArgs(["--platform=darwin"]), {
    platform: "darwin",
  });
  assert.throws(
    () => gui.parseRinGuiArgs(["--web"]),
    /rin_gui_browser_surface_removed:--web/,
  );
  assert.throws(
    () => gui.parseRinGuiArgs(["--host", "127.0.0.1"]),
    /rin_gui_browser_surface_removed:--host/,
  );
  assert.throws(
    () => gui.parseRinGuiArgs(["--app"]),
    /rin_gui_browser_surface_removed:--app/,
  );
});

test("native desktop platform resolution is explicitly cross-platform", () => {
  assert.equal(nativeDesktop.nativeDesktopPlatformFor("win32"), "win32");
  assert.equal(nativeDesktop.nativeDesktopPlatformFor("darwin"), "darwin");
  assert.equal(nativeDesktop.nativeDesktopPlatformFor("linux"), "linux");
  assert.throws(
    () => nativeDesktop.nativeDesktopPlatformFor("freebsd"),
    /rin_gui_native_platform_unsupported:freebsd/,
  );
});

test("native desktop scripts use OS GUI toolkits without browser hosting", () => {
  const windows = nativeDesktop.buildNativeDesktopGuiScript({
    title: "Rin",
    platform: "win32",
  });
  const macos = nativeDesktop.buildNativeDesktopGuiScript({
    title: "Rin",
    platform: "darwin",
  });
  const linux = nativeDesktop.buildNativeDesktopGuiScript({
    title: "Rin",
    platform: "linux",
  });

  assert.equal(windows.command, "powershell.exe");
  assert.match(windows.source, /Add-Type -AssemblyName PresentationFramework/);
  assert.match(windows.source, /System\.Windows\.Window/);

  assert.equal(macos.command, "osascript");
  assert.match(macos.source, /ObjC\.import\('Cocoa'\)/);
  assert.match(macos.source, /NSWindow/);

  assert.equal(linux.command, "python3");
  assert.match(linux.source, /import tkinter as tk/);
  assert.match(linux.source, /root = tk\.Tk\(\)/);

  for (const script of [windows, macos, linux]) {
    assert.doesNotMatch(script.source, /WebSocket/);
    assert.doesNotMatch(script.source, /http:\/\//);
    assert.doesNotMatch(
      script.source,
      /msedge|chromium|google-chrome|xdg-open/,
    );
  }
});

test("Windows default launch mode is GUI-first while other platforms keep TUI", () => {
  assert.equal(main.defaultLaunchModeForPlatform("win32"), "gui");
  assert.equal(main.defaultLaunchModeForPlatform("linux"), "tui");
  assert.equal(main.defaultLaunchModeForPlatform("darwin"), "tui");
});
