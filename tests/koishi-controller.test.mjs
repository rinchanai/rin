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
const {
  KoishiChatController,
  normalizeKoishiIdleToolProgressConfig,
  summarizeKoishiToolCall,
} = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "controller.js"),
  ).href
);

async function createController(chatKey = "telegram/1:2") {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-koishi-controller-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new KoishiChatController({}, dataDir, chatKey, {
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
  controller.scheduleIdleDetach = () => {};
  controller.clearIdleDetachTimer = () => {};
  return controller;
}

test("koishi controller uses RpcInteractiveSession session bootstrap before first command on a fresh chat", async () => {
  const controller = await createController();
  const calls = [];
  const namedSessions = [];

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
      return { handled: true };
    },
    setSessionName: async (name) => {
      namedSessions.push(name);
    },
  };

  await controller.runCommand("/session");

  assert.deepEqual(calls, ["ensureSessionReady", "runCommand:/session"]);
  assert.deepEqual(namedSessions, ["telegram/1:2", "telegram/1:2"]);
  assert.equal(controller.state.piSessionFile, "/tmp/fresh-chat.jsonl");
});

test("koishi controller polls telegram typing only while the controller still owns a live turn", async () => {
  const controller = await createController("telegram/1:2");
  const actions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
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

  controller.session = { isStreaming: false };
  controller.state.processing = undefined;
  controller.liveTurn = null;
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);

  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
  };
  controller.liveTurn = {
    promise: Promise.resolve(),
    resolve() {},
    reject() {},
  };
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);

  controller.session = { isStreaming: false };
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
});

test("koishi controller uses RpcInteractiveSession prompt path for chat turns", async () => {
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

test("koishi controller resolves final output from session lifecycle for prompt turns", async () => {
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

test("koishi controller reattaches saved session file before bootstrapping a detached session", async () => {
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

test("koishi controller self-heals missing saved session binding before a chat turn", async () => {
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

test("koishi controller summarizes idle tool progress with compact tool input", () => {
  assert.equal(
    summarizeKoishiToolCall("bash", { command: "npm test -- --watch=false" }),
    "bash npm test -- --watch=false",
  );
  assert.equal(
    summarizeKoishiToolCall("read", {
      path: "/tmp/demo.txt",
      offset: 5,
      limit: 10,
    }),
    "read /tmp/demo.txt:5-14",
  );
  assert.equal(
    summarizeKoishiToolCall("edit", {
      path: "/tmp/demo.txt",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    }),
    "edit /tmp/demo.txt (2 edits)",
  );
});

test("koishi controller idle tool progress intervals default to 60s and stay configurable", () => {
  assert.deepEqual(normalizeKoishiIdleToolProgressConfig({}), {
    privateIntervalMs: 60000,
    groupIntervalMs: 60000,
  });
  assert.deepEqual(
    normalizeKoishiIdleToolProgressConfig({
      koishi: {
        idleToolProgress: {
          privateIntervalMs: 15000,
          groupIntervalMs: 45000,
        },
      },
    }),
    {
      privateIntervalMs: 15000,
      groupIntervalMs: 45000,
    },
  );
});

test("koishi controller no longer emits idle working progress messages", async () => {
  const controller = await createController("telegram/1:2");
  controller.idleToolProgressConfig = {
    privateIntervalMs: 10000,
    groupIntervalMs: 10000,
  };
  controller.lastToolCallSummary = "Working";
  controller.session = { isStreaming: true };
  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
  };
  controller.liveTurn = {
    promise: Promise.resolve(),
    resolve() {},
    reject() {},
  };
  controller.lastVisibleProgressAt = 1000;
  controller.lastIdleToolProgressAt = 0;

  const sent = [];
  controller.emitProgressText = async (text) => {
    sent.push(text);
    return true;
  };
  controller.scheduleIdleToolProgress();
  assert.equal(controller.idleToolProgressTimer, null);

  await controller.handleIdleToolProgressTick(22050);
  assert.deepEqual(sent, []);
  assert.equal(controller.idleToolProgressTimer, null);
});

test("koishi controller refreshes session messages before resolving a final chat reply", async () => {
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

test("koishi controller takes final chat text from session lifecycle instead of rpc completion payload", async () => {
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

test("koishi controller rejects the owned turn on connection loss", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = { isStreaming: true };
  const liveTurn = controller.startLiveTurn();
  controller.handleClientEvent({ type: "ui", name: "connection_lost" });
  await assert.rejects(liveTurn.promise, /rin_disconnected:rpc_turn/);
  assert.equal(controller.liveTurn, null);
});

test("koishi controller steers an active chat turn instead of queueing a replacement", async () => {
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
  controller.liveTurn = {
    promise: new Promise(() => {}),
    resolve() {},
    reject() {},
  };
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

test("koishi controller still steers when the attached session is streaming without a local live turn", async () => {
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

  assert.equal(controller.hasActiveTurn(), true);

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

test("koishi controller serializes chat turns instead of replacing the active one", async () => {
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

test("koishi controller delivers completed assistant text during recovery when processing state is stale", async () => {
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

test("koishi controller retries persisted final reply delivery on recovery", async () => {
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

test("koishi controller falls back to interim text instead of throwing final_assistant_text_missing", async () => {
  const controller = await createController("telegram/9:11");
  const delivered = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delivered.push(controller.latestAssistantText);
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [] },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/interim-chat.jsonl",
      getSessionId: () => "session-interim",
      getSessionName: () => "telegram/9:11",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/interim-chat.jsonl",
      sessionId: "session-interim",
    }),
    prompt: async () => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      controller.handleSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "interim visible text" }],
        },
      });
      queueMicrotask(() => {
        controller.session.isStreaming = false;
        controller.handleSessionEvent({ type: "agent_end" });
      });
    },
    setSessionName: async () => {},
    switchSession: async () => {},
    refreshState: async () => {},
  };

  const result = await controller.runTurn(
    { text: "hello", attachments: [] },
    "prompt",
  );

  assert.equal(result.finalText, "interim visible text");
  assert.deepEqual(delivered, ["interim visible text"]);
});
