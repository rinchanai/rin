import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { ChatController } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js"))
    .href
);

async function createController(chatKey = "telegram/1:2") {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController({}, dataDir, chatKey, {
    logger: { info() {}, warn() {} },
    h: {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
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
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.connect = async () => {};
  return controller;
}

test("chat controller uses RpcInteractiveSession session bootstrap before first command on a fresh chat", async () => {
  const controller = await createController();
  const calls = [];
  const namedSessions = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.state.pendingDelivery?.text || "");
    delete this.state.pendingDelivery;
    this.saveState();
  };

  controller.session = {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "",
      getSessionName: () => "",
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return { sessionFile: "/tmp/fresh-chat.jsonl", sessionId: "session-1" };
    },
    runCommand: async (commandLine) => {
      calls.push(`runCommand:${commandLine}`);
      return { handled: true, text: "Session stats" };
    },
    setSessionName: async (name) => {
      namedSessions.push(name);
    },
  };

  await controller.runCommand("/session");

  assert.deepEqual(calls, ["ensureSessionReady", "runCommand:/session"]);
  assert.deepEqual(namedSessions, ["telegram/1:2", "telegram/1:2"]);
  assert.deepEqual(deliveries, ["Session stats"]);
  assert.equal(controller.state.piSessionFile, "/tmp/fresh-chat.jsonl");
});

test("chat controller delivers a visible command error instead of failing silently", async () => {
  const controller = await createController();
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.state.pendingDelivery?.text || "");
    delete this.state.pendingDelivery;
    this.saveState();
  };

  controller.session = {
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-1",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/fresh-chat.jsonl",
      sessionId: "session-1",
    }),
    runCommand: async () => {
      throw new Error("boom");
    },
  };

  await assert.rejects(controller.runCommand("/reload"), /boom/);
  assert.deepEqual(deliveries, ["Chat bridge error: boom"]);
});

test("chat controller polls typing and rotating reactions while a chat turn is still pending", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async createReaction(chatId, messageId, emoji) {
          reactions.push(["create", chatId, messageId, emoji]);
        },
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction(payload) {
            actions.push(payload);
          },
        },
      },
    ],
  };

  controller.session = { isStreaming: false };
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);

  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    incomingMessageId: "m1",
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});
  assert.equal(controller.hasActiveTurn(), true);
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m1", "👀"]]);

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "👀"]]);
});

test("chat controller uses a fixed Working notice policy for onebot private chats", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  controller.app = {
    bots: [
      {
        platform: "onebot",
        selfId: "1",
        async sendMessage(chatId, content) {
          deliveries.push({ chatId, content });
          return ["working-msg-1"];
        },
      },
    ],
  };

  controller.session = { isStreaming: false };
  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    incomingMessageId: "m1",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), true);
  assert.equal(await controller.pollTyping(), false);
  assert.equal(controller.state.processing.workingNoticeSent, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chatId, "private:2");
  assert.equal(deliveries[0].content[0].attrs.id, "m1");
  assert.equal(deliveries[0].content[1].attrs.content, "Working……");
});

test("chat controller uses RpcInteractiveSession prompt path for chat turns", async () => {
  const controller = await createController("telegram/9:9");
  const calls = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    calls.push("deliver:final-text");
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/turn-chat.jsonl",
      getSessionId: () => "session-turn",
      getSessionName: () => "telegram/9:9",
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return { sessionFile: "/tmp/turn-chat.jsonl", sessionId: "session-turn" };
    },
    prompt: async (_message, options) => {
      calls.push(`prompt:${options?.streamingBehavior || "none"}`);
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn({ text: "hello", attachments: [] }, "prompt");

  assert.deepEqual(calls, [
    "ensureSessionReady",
    "prompt:none",
    "deliver:final-text",
  ]);
  assert.equal(controller.state.piSessionFile, "/tmp/turn-chat.jsonl");
});

test("chat controller resolves final output from session lifecycle for prompt turns", async () => {
  const controller = await createController("telegram/9:10");
  const delivered = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delivered.push(controller.latestAssistantText);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/fallback-chat.jsonl",
      getSessionId: () => "session-fallback",
      getSessionName: () => "telegram/9:10",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/fallback-chat.jsonl",
      sessionId: "session-fallback",
    }),
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.messages = [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "prompt final text" }],
          },
        ];
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn({ text: "hello", attachments: [] }, "prompt");

  assert.deepEqual(delivered, ["prompt final text"]);
});

test("chat controller reattaches saved session file before bootstrapping a detached session", async () => {
  const controller = await createController("telegram/7:7");
  const calls = [];
  const savedSessionFile = path.join(controller.dataDir, "saved-chat.jsonl");
  await fs.writeFile(savedSessionFile, "", "utf8");
  controller.state.piSessionFile = savedSessionFile;

  controller.session = {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "",
      getSessionName: () => "telegram/7:7",
    },
    switchSession: async (sessionPath) => {
      calls.push(`switch:${sessionPath}`);
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return { sessionFile: savedSessionFile, sessionId: "session-7" };
    },
    setSessionName: async () => {},
  };

  await controller.ensureSessionReady();

  assert.deepEqual(calls, [`switch:${savedSessionFile}`, "ensureSessionReady"]);
  assert.equal(controller.state.piSessionFile, savedSessionFile);
});

test("chat controller reattaches idle saved sessions during recovery so chat workers stay attached", async () => {
  const controller = await createController("telegram/7:7");
  const calls = [];
  const savedSessionFile = path.join(controller.dataDir, "saved-chat.jsonl");
  await fs.writeFile(savedSessionFile, "", "utf8");
  controller.state.piSessionFile = savedSessionFile;

  controller.session = {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "",
      getSessionName: () => "telegram/7:7",
    },
    switchSession: async (sessionPath) => {
      calls.push(`switch:${sessionPath}`);
    },
    setSessionName: async () => {},
  };

  await controller.recoverIfNeeded();

  assert.deepEqual(calls, [`switch:${savedSessionFile}`]);
});

test("chat controller self-heals missing saved session binding before a chat turn", async () => {
  const controller = await createController("telegram/7:8");
  const calls = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    calls.push(`deliver:${controller.latestAssistantText}`);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };
  controller.state.piSessionFile = "/tmp/missing-chat.jsonl";

  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "fresh session final" }],
      },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/fresh-chat.jsonl",
      getSessionId: () => "session-fresh",
      getSessionName: () => "telegram/7:8",
    },
    switchSession: async (sessionPath) => {
      calls.push(`switch:${sessionPath}`);
    },
    ensureSessionReady: async () => {
      calls.push("ensureSessionReady");
      return {
        sessionFile: "/tmp/fresh-chat.jsonl",
        sessionId: "session-fresh",
      };
    },
    prompt: async () => {
      calls.push("prompt");
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
  };

  await controller.runTurn({ text: "hello", attachments: [] }, "prompt");

  assert.deepEqual(calls, [
    "ensureSessionReady",
    "prompt",
    "deliver:fresh session final",
  ]);
  assert.equal(controller.state.piSessionFile, "/tmp/fresh-chat.jsonl");
});

test("chat controller clears its working reaction after final delivery", async () => {
  const controller = await createController("telegram/1:2");
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push([chatId, messageId, emoji, userId]);
        },
      },
    ],
  };
  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    incomingMessageId: "m1",
  };
  controller.state.pendingDelivery = {
    type: "text_delivery",
    chatKey: "telegram/1:2",
    text: "done",
  };
  controller.workingReactionEmoji = "🌗";
  controller.deliveryEnabled = false;

  await controller.commitPendingDelivery(true);

  assert.equal(controller.state.processing, undefined);
  assert.equal(controller.workingReactionEmoji, "");
  assert.deepEqual(reactions, [["2", "m1", "🌗", "1"]]);
});

test("chat controller refreshes session messages before resolving a final chat reply", async () => {
  const controller = await createController("telegram/1:4");
  const delivered = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delivered.push(controller.latestAssistantText);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/session-refresh.jsonl",
      getSessionId: () => "session-refresh",
      getSessionName: () => "telegram/1:4",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/session-refresh.jsonl",
      sessionId: "session-refresh",
    }),
    refreshState: async () => {
      controller.session.messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "refreshed final text" }],
        },
      ];
    },
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn({ text: "hello", attachments: [] }, "prompt");

  assert.deepEqual(delivered, ["refreshed final text"]);
});

test("chat controller takes final chat text from session lifecycle instead of rpc completion payload", async () => {
  const controller = await createController("telegram/1:3");
  const delivered = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delivered.push(controller.latestAssistantText);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/session-lifecycle.jsonl",
      getSessionId: () => "session-lifecycle",
      getSessionName: () => "telegram/1:3",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/session-lifecycle.jsonl",
      sessionId: "session-lifecycle",
    }),
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      controller.handleClientEvent({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "complete",
          result: { messages: [{ type: "text", text: "rpc final text" }] },
        },
      });
      queueMicrotask(() => {
        controller.session.messages = [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "session final text" }],
          },
        ];
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  await controller.runTurn({ text: "hello", attachments: [] }, "prompt");

  assert.deepEqual(delivered, ["session final text"]);
});

test("chat controller rejects the owned turn on connection loss", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = { isStreaming: true };
  const liveTurn = controller.startLiveTurn();
  controller.handleClientEvent({ type: "ui", name: "connection_lost" });
  await assert.rejects(liveTurn.promise, /rin_disconnected:rpc_turn/);
  assert.equal(controller.liveTurn, null);
});

test("chat controller rejects the owned turn on worker exit", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = { isStreaming: true };
  const liveTurn = controller.startLiveTurn("tag-worker-exit");
  controller.handleClientEvent({
    type: "ui",
    name: "worker_exit",
    payload: { code: 9, signal: null },
  });
  await assert.rejects(liveTurn.promise, /rin_worker_exit:code=9:signal=null/);
  assert.equal(controller.liveTurn, null);
});

test("chat controller keeps a quiet long-running turn alive while the session still reports streaming", async () => {
  const controller = await createController("telegram/1:2");
  let refreshCalls = 0;
  let recoverCalls = 0;
  controller.session = {
    isStreaming: true,
    isCompacting: false,
    refreshState: async () => {
      refreshCalls += 1;
      controller.session.isStreaming = true;
    },
    sessionManager: {
      getSessionFile: () => "/tmp/quiet-stream.jsonl",
      getSessionId: () => "session-quiet-stream",
      getSessionName: () => "telegram/1:2",
    },
  };
  controller.recoverIfNeeded = async () => {
    recoverCalls += 1;
  };
  const liveTurn = controller.startLiveTurn("tag-quiet-stream");
  liveTurn.promise.catch(() => {});
  controller.lastTurnPulseAt = Date.now() - 120_000;
  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    incomingMessageId: "m1",
  };

  await controller.housekeep();

  assert.equal(refreshCalls, 1);
  assert.equal(recoverCalls, 0);
  assert.equal(controller.liveTurn, liveTurn);
  assert.equal(controller.hasActiveTurn(), true);
});

test("chat controller steers an active chat turn instead of queueing a replacement", async () => {
  const controller = await createController("telegram/1:2");
  const calls = [];
  controller.session = {
    isStreaming: true,
    sessionManager: {
      getSessionFile: () => "/tmp/steer-chat.jsonl",
      getSessionId: () => "session-steer",
      getSessionName: () => "telegram/1:2",
    },
    prompt: async (message, options) => {
      calls.push(`prompt:${message}:${options?.streamingBehavior || "none"}`);
    },
  };
  controller.state.processing = {
    text: "first",
    attachments: [],
    startedAt: Date.now(),
    replyToMessageId: "old",
  };
  const liveTurn = controller.startLiveTurn("tag-steer");
  liveTurn.promise.catch(() => {});
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    calls.push("deliver");
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  const result = await controller.runTurn(
    {
      text: "interrupt",
      attachments: [],
      replyToMessageId: "new",
      incomingMessageId: "m2",
    },
    "steer",
  );

  assert.deepEqual(calls, ["prompt:interrupt:steer"]);
  assert.equal(controller.state.processing.replyToMessageId, "new");
  assert.equal(result?.steered, true);
});

test("chat controller still steers when the attached session is streaming without a local live turn", async () => {
  const controller = await createController("telegram/1:2");
  const calls = [];
  controller.session = {
    isStreaming: true,
    sessionManager: {
      getSessionFile: () => "/tmp/steer-chat.jsonl",
      getSessionId: () => "session-steer",
      getSessionName: () => "telegram/1:2",
    },
    prompt: async (message, options) => {
      calls.push(`prompt:${message}:${options?.streamingBehavior || "none"}`);
    },
  };
  controller.state.processing = {
    text: "first",
    attachments: [],
    startedAt: Date.now(),
    replyToMessageId: "old",
  };
  controller.liveTurn = null;
  controller.lastTurnPulseAt = Date.now();

  assert.equal(controller.hasActiveTurn(), false);

  const result = await controller.runTurn(
    {
      text: "interrupt",
      attachments: [],
      replyToMessageId: "new",
      incomingMessageId: "m2",
    },
    "steer",
  );

  assert.deepEqual(calls, ["prompt:interrupt:steer"]);
  assert.equal(controller.state.processing.replyToMessageId, "new");
  assert.equal(result?.steered, true);
});

test("chat controller serializes chat turns instead of replacing the active one", async () => {
  const controller = await createController("telegram/1:2");
  const order = [];
  let finishFirst;
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    order.push(`deliver:${controller.latestAssistantText}`);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/serial-chat.jsonl",
      getSessionId: () => "session-serial",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/serial-chat.jsonl",
      sessionId: "session-serial",
    }),
    prompt: async (message) => {
      order.push(`prompt:${message}`);
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      if (message === "first") {
        await new Promise((resolve) => {
          finishFirst = () => {
            controller.session.messages = [
              { role: "user", content: [{ type: "text", text: "first" }] },
              {
                role: "assistant",
                content: [{ type: "text", text: "first done" }],
              },
            ];
            controller.session.isStreaming = false;
            controller.handleSessionEvent({ type: "agent_end" });
            resolve();
          };
        });
        return;
      }
      controller.session.messages = [
        { role: "user", content: [{ type: "text", text: "second" }] },
        { role: "assistant", content: [{ type: "text", text: "second done" }] },
      ];
      controller.session.isStreaming = false;
      controller.handleSessionEvent({ type: "agent_end" });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  const first = controller.runTurn(
    { text: "first", attachments: [] },
    "prompt",
  );
  const second = controller.runTurn(
    { text: "second", attachments: [] },
    "prompt",
  );
  for (let i = 0; i < 20 && typeof finishFirst !== "function"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof finishFirst, "function");
  assert.deepEqual(order, ["prompt:first"]);
  finishFirst();
  await first;
  await second;
  assert.deepEqual(order, [
    "prompt:first",
    "deliver:first done",
    "prompt:second",
    "deliver:second done",
  ]);
});

test("chat controller delivers completed assistant text during recovery when processing state is stale", async () => {
  const controller = await createController("telegram/1:2");
  const delivered = [];
  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    replyToMessageId: "42",
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    if (controller.latestAssistantText) {
      delivered.push({
        text: controller.latestAssistantText,
        replyToMessageId: "42",
      });
    }
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };
  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "final from recovery" }],
      },
    ],
  };

  await controller.recoverIfNeeded();

  assert.equal(controller.state.processing, undefined);
  assert.deepEqual(delivered, [
    { text: "final from recovery", replyToMessageId: "42" },
  ]);
});

test("chat controller retries persisted final reply delivery on recovery", async () => {
  const controller = await createController("telegram/1:2");
  const sends = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage(chatId, content) {
          sends.push({ chatId, content });
          return ["m1"];
        },
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.h = {
    text(content) {
      return { type: "text", attrs: { content } };
    },
    quote(id) {
      return { type: "quote", attrs: { id } };
    },
  };
  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "final text" }] },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/recover-chat.jsonl",
      getSessionId: () => "session-recover",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/recover-chat.jsonl",
      sessionId: "session-recover",
    }),
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
  };

  const originalCommitPendingDelivery = controller.commitPendingDelivery;
  controller.commitPendingDelivery = async () => {};
  await controller.runTurn(
    { text: "hello", attachments: [], replyToMessageId: "42" },
    "prompt",
  );

  assert.equal(controller.state.pendingDelivery?.text, "final text");
  assert.equal(sends.length, 0);

  controller.commitPendingDelivery = originalCommitPendingDelivery;
  await controller.recoverIfNeeded();

  assert.equal(controller.state.pendingDelivery, undefined);
  assert.equal(sends.length, 1);
});

test("chat controller keeps cron turns off the chat mainline while preserving the real delivery chatKey", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-detached-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController(
    {},
    dataDir,
    "onebot/2301401877:1090441185",
    {
      logger: { info() {}, warn() {} },
      h: {
        text(content) {
          return { type: "text", attrs: { content } };
        },
        quote(id) {
          return { type: "quote", attrs: { id } };
        },
      },
      deliveryEnabled: false,
      affectChatBinding: false,
      statePath: path.join(dataDir, "cron-turns", "task-1", "state.json"),
    },
  );
  controller.app = { bots: [] };
  controller.connect = async () => {};
  const setNames = [];
  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "final text" }] },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/cron-detached.jsonl",
      getSessionId: () => "session-detached",
      getSessionName: () => "",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/cron-detached.jsonl",
      sessionId: "session-detached",
    }),
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async (name) => {
      setNames.push(name);
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn(
    { text: "hello", attachments: [] },
    "prompt",
  );

  assert.equal(result?.finalText, "final text");
  assert.equal(controller.state.chatKey, "onebot/2301401877:1090441185");
  assert.equal(controller.state.pendingDelivery, undefined);
  assert.deepEqual(setNames, []);
});
