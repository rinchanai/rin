import http from "node:http";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";

import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  extractSubcommandArgv,
  ParsedArgs,
} from "../rin/shared.js";

import { runWindowsNativeGui } from "./native-windows.js";
import { buildGuiHtml, parseRinGuiArgs } from "./web-assets.js";

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function buildOpenBrowserInvocation(
  url: string,
  options: { app?: boolean; platform?: NodeJS.Platform } = {},
) {
  const platform = options.platform || process.platform;
  if (options.app) {
    if (platform === "win32") {
      return {
        command: "cmd",
        args: ["/c", "start", "", "msedge", `--app=${url}`],
      };
    }
    if (platform === "darwin") {
      return {
        command: "open",
        args: ["-a", "Google Chrome", "--args", `--app=${url}`],
      };
    }
    return {
      command: "sh",
      args: [
        "-lc",
        `google-chrome --app=${JSON.stringify(url)} || chromium --app=${JSON.stringify(url)} || xdg-open ${JSON.stringify(url)}`,
      ],
    };
  }
  const command =
    platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  return { command, args };
}

function openBrowser(url: string, options: { app?: boolean } = {}) {
  const invocation = buildOpenBrowserInvocation(url, options);
  try {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function normalizeHostForUrl(host: string) {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function runGui(parsed: ParsedArgs, rawArgv: string[] = []) {
  const guiArgs = extractSubcommandArgv(rawArgv, "gui");
  const options = parseRinGuiArgs(guiArgs);
  const context = createTargetExecutionContext(parsed);

  await ensureDaemonAvailable(context);

  if (
    options.surface !== "web" &&
    (options.surface === "native" || process.platform === "win32")
  ) {
    const client = new RinDaemonFrontendClient(context.socketPath);
    await client.connect();
    try {
      await runWindowsNativeGui({ client, title: "Rin" });
    } finally {
      await client.disconnect();
    }
    return;
  }

  const html = buildGuiHtml({ title: "Rin" });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  const wss = new WebSocketServer({ server, path: "/rpc" });

  wss.on("connection", (socket) => {
    const client = new RinDaemonFrontendClient(context.socketPath);
    const unsubscribe = client.subscribe((event) => {
      sendJson(socket, { type: "event", event });
    });

    client
      .connect()
      .then(() =>
        sendJson(socket, {
          type: "status",
          level: "info",
          text: "Connected to Rin daemon",
        }),
      )
      .catch((error: any) => {
        sendJson(socket, {
          type: "status",
          level: "error",
          text: String(error?.message || error || "rin_gui_connect_failed"),
        });
      });

    socket.on("message", (payload) => {
      void (async () => {
        let command: any;
        try {
          command = JSON.parse(String(payload));
        } catch {
          sendJson(socket, {
            type: "status",
            level: "error",
            text: "Invalid JSON",
          });
          return;
        }
        try {
          if (command?.type === "prompt") {
            await client.submit(String(command.text || ""));
          } else if (command?.type === "abort") {
            await client.abort();
          } else {
            sendJson(socket, {
              type: "status",
              level: "warning",
              text: `Unsupported GUI command: ${String(command?.type || "")}`,
            });
          }
        } catch (error: any) {
          sendJson(socket, {
            type: "status",
            level: "error",
            text: String(error?.message || error || "rin_gui_command_failed"),
          });
        }
      })();
    });

    socket.on("close", () => {
      unsubscribe();
      void client.disconnect();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port, options.host, resolve),
  );
  const address = server.address() as AddressInfo;
  const url = `http://${normalizeHostForUrl(options.host)}:${address.port}/`;
  console.log(`rin gui: ${url}`);
  if (options.open) openBrowser(url, { app: options.app });
}
