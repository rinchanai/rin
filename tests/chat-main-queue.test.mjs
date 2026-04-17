import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("chat main consumes inbound help messages through the inbox path only once", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(path.join(tempRoot, "rin-chat-main-queue-"));
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "u1",
        messageId: "m1",
        isDirect: true,
        content: "/help",
        stripped: { content: "/help" },
        elements: [h.createChatRuntimeH().text("/help")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await new Promise((resolve) => setTimeout(resolve, 3500));
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      if (rows.length !== 1) {
        throw new Error(
          JSON.stringify({
            sentCount,
            assistantCount: rows.length,
            texts: rows.map((item) => item.text),
          }),
        );
      }
      process.exit(0);
    `;

    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_REPO_ROOT: rootDir,
        RIN_DIR: agentDir,
      },
      timeout: 15000,
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main does not retry a queued prompt while the controller is already handling that inbound message", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(path.join(tempRoot, "rin-chat-main-queue-"));
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let promptCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          isCompacting: false,
          messages: [],
          subscribe: () => () => {},
          sessionManager: {
            getSessionFile: () => "/tmp/slow-chat.jsonl",
            getSessionId: () => "slow-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            return {
              sessionFile: "/tmp/slow-chat.jsonl",
              sessionId: "slow-session",
            };
          },
          prompt: async (_message, options = {}) => {
            promptCalls += 1;
            setTimeout(() => {
              controller.handleClientEvent({
                type: "ui",
                payload: {
                  type: "rpc_turn_event",
                  event: "complete",
                  requestTag: options.requestTag,
                  finalText: "slow reply",
                  result: { messages: [{ type: "text", text: "slow reply" }] },
                  sessionId: "slow-session",
                  sessionFile: "/tmp/slow-chat.jsonl",
                },
              });
            }, 10);
          },
          refreshState: async () => {},
          refreshMessages: async () => {},
          switchSession: async () => {},
          setSessionName: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-slow",
        isDirect: true,
        content: "hello slow world",
        stripped: { content: "hello slow world" },
        elements: [h.createChatRuntimeH().text("hello slow world")],
      });

      await new Promise((resolve) => setTimeout(resolve, 12500));

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      if (promptCalls !== 1 || rows.length !== 1) {
        throw new Error(
          JSON.stringify({
            promptCalls,
            assistantCount: rows.length,
            texts: rows.map((item) => item.text),
          }),
        );
      }
      process.exit(0);
    `;

    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_REPO_ROOT: rootDir,
        RIN_DIR: agentDir,
      },
      timeout: 25000,
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
