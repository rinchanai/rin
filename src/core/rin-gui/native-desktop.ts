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
