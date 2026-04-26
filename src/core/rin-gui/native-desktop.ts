import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";

export type NativeDesktopHostLaunch = {
  command: string;
  args: string[];
};

const DEFAULT_NATIVE_DESKTOP_HOST = "rin-desktop-host";

function splitHostCommand(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function buildNativeDesktopHostLaunch(
  env: NodeJS.ProcessEnv = process.env,
): NativeDesktopHostLaunch {
  const parts = splitHostCommand(
    env.RIN_GUI_NATIVE_HOST || DEFAULT_NATIVE_DESKTOP_HOST,
  );
  const command = parts.shift() || DEFAULT_NATIVE_DESKTOP_HOST;
  return { command, args: [...parts, "--stdio"] };
}

function frontendEventText(event: any) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "status") return String(event.text || "");
  const payload = event.payload || event;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  return JSON.stringify(payload);
}

function sendNativeEvent(stdin: NodeJS.WritableStream, payload: unknown) {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

export async function runNativeDesktopGui(options: {
  client: RinDaemonFrontendClient;
  env?: NodeJS.ProcessEnv;
}) {
  const launch = buildNativeDesktopHostLaunch(options.env);
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: false,
  });

  const client = options.client;
  const unsubscribe = client.subscribe((event) => {
    sendNativeEvent(child.stdin, {
      type: event.type === "status" ? "status" : "message",
      role: event.type === "status" ? "system" : event.type,
      text: frontendEventText(event),
    });
  });

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      void (async () => {
        let command: any;
        try {
          command = JSON.parse(line);
        } catch {
          return;
        }
        if (command?.type === "prompt") {
          await client.submit(String(command.text || ""));
        } else if (command?.type === "abort") {
          await client.abort();
        } else if (command?.type === "close") {
          child.kill();
        }
      })().catch((error) => {
        sendNativeEvent(child.stdin, {
          type: "status",
          text: String(
            error?.message || error || "rin_native_gui_command_failed",
          ),
        });
      });
    }
  });

  sendNativeEvent(child.stdin, {
    type: "status",
    text: "Connected to local Rin daemon",
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    unsubscribe();
    try {
      child.stdin.end();
    } catch {}
  });
}

export function buildElectronDesktopHostPreloadScript() {
  return `const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rinDesktop', {
  send(command) {
    ipcRenderer.send('rin-command', command);
  },
  onEvent(callback) {
    ipcRenderer.on('rin-event', (_event, payload) => callback(payload));
  }
});
`;
}

export function buildElectronDesktopHostMainScript(options: {
  preloadPath: string;
  title?: string;
}) {
  const title = JSON.stringify(options.title || "Rin");
  const preloadPath = JSON.stringify(options.preloadPath);
  return (
    `const { app, BrowserWindow, ipcMain } = require('electron');
const readline = require('node:readline');

let mainWindow = null;
const queuedEvents = [];

function sendCommand(command) {
  process.stdout.write(JSON.stringify(command) + '\\n');
}

function postEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    queuedEvents.push(payload);
    return;
  }
  mainWindow.webContents.send('rin-event', payload);
}

function flushEvents() {
  while (queuedEvents.length > 0) postEvent(queuedEvents.shift());
}

function html() {
  return ` +
    JSON.stringify(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline';" />
  <title>Rin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
    header { padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    h1 { margin: 0; font-size: 18px; }
    #status { font-size: 12px; opacity: 0.72; margin-top: 4px; }
    #messages { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .message { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; }
    .message.user { align-self: flex-end; background: color-mix(in srgb, Highlight 14%, Canvas); }
    .message.assistant { align-self: flex-start; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .message.system { align-self: center; font-size: 12px; opacity: 0.72; }
    form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 12px 16px; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    textarea { resize: vertical; min-height: 44px; max-height: 30vh; border-radius: 8px; padding: 10px; font: inherit; }
    button { border-radius: 8px; padding: 0 14px; font: inherit; }
  </style>
</head>
<body>
  <main>
    <header><h1>Rin</h1><div id="status">Connected to local Rin daemon</div></header>
    <section id="messages" aria-live="polite"></section>
    <form id="prompt-form">
      <textarea id="prompt" placeholder="Ask Rin…" autofocus></textarea>
      <button type="submit">Send</button>
      <button id="abort" type="button">Abort</button>
    </form>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('prompt-form');
    const promptEl = document.getElementById('prompt');
    const abortEl = document.getElementById('abort');
    function appendMessage(role, text) {
      if (!text) return;
      const node = document.createElement('div');
      node.className = 'message ' + (role || 'system');
      node.textContent = text;
      messagesEl.appendChild(node);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    window.rinDesktop.onEvent((payload) => {
      if (payload.type === 'status') statusEl.textContent = payload.text || 'Status';
      else appendMessage(payload.role || payload.type, payload.text || JSON.stringify(payload));
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = promptEl.value.trim();
      if (!text) return;
      appendMessage('user', text);
      promptEl.value = '';
      window.rinDesktop.send({ type: 'prompt', text });
    });
    abortEl.addEventListener('click', () => window.rinDesktop.send({ type: 'abort' }));
  </script>
</body>
</html>`) +
    `;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: ${title},
    webPreferences: {
      preload: ${preloadPath},
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html()));
  mainWindow.webContents.once('did-finish-load', flushEvents);
  mainWindow.on('closed', () => {
    sendCommand({ type: 'close' });
    mainWindow = null;
  });
}

ipcMain.on('rin-command', (_event, command) => sendCommand(command));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { postEvent(JSON.parse(line)); } catch {}
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
`
  );
}

export function createElectronDesktopHostFiles(
  options: { title?: string } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-electron-host-"));
  const preloadPath = path.join(dir, "preload.cjs");
  const mainPath = path.join(dir, "main.cjs");
  fs.writeFileSync(
    preloadPath,
    buildElectronDesktopHostPreloadScript(),
    "utf8",
  );
  fs.writeFileSync(
    mainPath,
    buildElectronDesktopHostMainScript({ preloadPath, title: options.title }),
    "utf8",
  );
  return { dir, mainPath, preloadPath };
}

export async function runElectronDesktopHost(options: {
  args?: string[];
  electronBinary: string;
  title?: string;
}) {
  const args = options.args || [];
  for (const arg of args) {
    if (arg !== "--stdio")
      throw new Error(`rin_desktop_host_unknown_arg:${arg}`);
  }
  const { dir, mainPath } = createElectronDesktopHostFiles({
    title: options.title,
  });
  const child = spawn(options.electronBinary, [mainPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
}
