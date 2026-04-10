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
    h: {},
  });
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

  controller.session = { isStreaming: true };
  controller.state.processing = undefined;
  controller.liveTurn = null;
  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);

  controller.state.processing = { text: "hello", attachments: [], startedAt: Date.now() };
  controller.liveTurn = {
    promise: Promise.resolve(),
    resolve() {},
    reject() {},
  };
  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
});

test("koishi controller uses RpcInteractiveSession prompt path for chat turns", async () => {
  const controller = await createController("telegram/9:9");
  const calls = [];
  controller.deliverFinalAssistantText = async () => {
    calls.push("deliver:final-text");
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

test("koishi controller resolves final output from session lifecycle for prompt and steer", async () => {
  const controller = await createController("telegram/9:10");
  const delivered = [];
  controller.deliverFinalAssistantText = async () => {
    delivered.push(controller.latestAssistantText);
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
    prompt: async (_message, options) => {
      controller.session.isStreaming = true;
      controller.handleSessionEvent({ type: "agent_start" });
      queueMicrotask(() => {
        controller.session.messages = [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: options?.streamingBehavior === "steer" ? "steer final text" : "prompt final text" }],
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
  await controller.runTurn({ text: "hello again", attachments: [] }, "steer");

  assert.deepEqual(delivered, ["prompt final text", "steer final text"]);
});

test("koishi controller reattaches saved session file before bootstrapping a detached session", async () => {
  const controller = await createController("telegram/7:7");
  const calls = [];
  controller.state.piSessionFile = "/tmp/saved-chat.jsonl";

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
      return { sessionFile: "/tmp/saved-chat.jsonl", sessionId: "session-7" };
    },
    setSessionName: async () => {},
  };

  await controller.ensureSessionReady();

  assert.deepEqual(calls, [
    "switch:/tmp/saved-chat.jsonl",
    "ensureSessionReady",
  ]);
  assert.equal(controller.state.piSessionFile, "/tmp/saved-chat.jsonl");
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
      edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }],
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

test("koishi controller emits idle tool progress only after a quiet interval", async () => {
  const controller = await createController("telegram/1:2");
  controller.idleToolProgressConfig = {
    privateIntervalMs: 10000,
    groupIntervalMs: 10000,
  };
  controller.lastToolCallSummary = "Working";
  controller.session = { isStreaming: true };
  controller.state.processing = { text: "hello", attachments: [], startedAt: Date.now() };
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
    controller.lastVisibleProgressAt = 12000;
    return true;
  };
  controller.scheduleIdleToolProgress = () => {};

  await controller.handleIdleToolProgressTick(9000);
  assert.deepEqual(sent, []);

  await controller.handleIdleToolProgressTick(11000);
  assert.deepEqual(sent, ["Working"]);

  await controller.handleIdleToolProgressTick(19000);
  assert.deepEqual(sent, ["Working"]);

  await controller.handleIdleToolProgressTick(22050);
  assert.deepEqual(sent, ["Working", "Working"]);
});

test("koishi controller rejects the owned turn on connection loss", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = { isStreaming: true };
  const liveTurn = controller.startLiveTurn();
  controller.handleClientEvent({ type: "ui", name: "connection_lost" });
  await assert.rejects(liveTurn.promise, /rin_disconnected:rpc_turn/);
  assert.equal(controller.liveTurn, null);
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
  controller.deliverFinalAssistantText = async (replyToMessageId) => {
    delivered.push({ text: controller.latestAssistantText, replyToMessageId });
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

