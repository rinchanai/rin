import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { ChatController } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js"))
    .href
);

async function createController(chatKey = "telegram/1:2") {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-abort-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController({}, dataDir, chatKey, {
    logger: { info() {}, warn() {} },
    h: {
      text(content: string) {
        return { type: "text", attrs: { content } };
      },
      quote(id: string) {
        return { type: "quote", attrs: { id } };
      },
    },
  });
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["m1"];
        },
        async createReaction() {},
        async deleteReaction() {},
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.connect = async () => {};
  return controller;
}

function emitRpcTurnComplete(
  controller: any,
  requestTag: string,
  finalText: string,
) {
  controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText,
      result: {
        messages: [{ type: "text", text: finalText }],
      },
      sessionId: controller.session?.sessionManager?.getSessionId?.(),
      sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
    },
  });
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("chat controller suppresses aborted turn errors and queues later text as a fresh prompt", async () => {
  const controller = await createController();
  const deliveries: string[] = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
  };

  const promptCalls: Array<{ text: string; streamingBehavior: string }> = [];
  let firstRequestTag = "";
  let secondRequestTag = "";
  controller.session = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-1",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/fresh-chat.jsonl",
      sessionId: "session-1",
    }),
    prompt: async (
      text: string,
      options: { requestTag?: string; streamingBehavior?: string } = {},
    ) => {
      promptCalls.push({
        text,
        streamingBehavior: options.streamingBehavior || "",
      });
      if (options.streamingBehavior) return;
      if (!firstRequestTag) {
        firstRequestTag = options.requestTag || "";
        await controller.handleClientEvent({
          type: "ui",
          payload: { type: "rpc_frontend_status", phase: "working" },
        });
        return;
      }
      secondRequestTag = options.requestTag || "";
    },
    runCommand: async () => ({
      handled: true,
      text: "Aborted current operation.",
    }),
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    replyToMessageId: "m1",
    incomingMessageId: "m1",
  });
  await waitUntil(() => Boolean(firstRequestTag), "first turn did not start");
  assert.equal(controller.canSteerActiveTurn(), true);

  await controller.runCommand("/abort", "m-abort", "m-abort");
  assert.equal(controller.canSteerActiveTurn(), false);
  assert.deepEqual(await firstTurn, {
    aborted: true,
    sessionId: "session-1",
    sessionFile: "/tmp/fresh-chat.jsonl",
  });

  const secondTurn = controller.runTurn(
    {
      text: "second",
      attachments: [],
      replyToMessageId: "m2",
      incomingMessageId: "m2",
    },
    "steer",
  );

  await waitUntil(() => Boolean(secondRequestTag), "second turn did not start");
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: "" },
    { text: "second", streamingBehavior: "" },
  ]);
  emitRpcTurnComplete(controller, secondRequestTag, "second done");
  assert.equal((await secondTurn).finalText, "second done");
  assert.deepEqual(deliveries, ["Aborted current operation.", "second done"]);
});
