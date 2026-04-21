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
const { getChatMessage, saveChatMessage } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
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

function emitRpcTurnComplete(controller, options, finalText, result) {
  controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: options?.requestTag,
      finalText,
      result:
        result || {
          messages: [{ type: "text", text: finalText }],
        },
      sessionId: controller.session?.sessionManager?.getSessionId?.(),
      sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
    },
  });
}

test("chat controller bootstraps a fresh session before the first command", async () => {
  const controller = await createController();
  const calls = [];
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
      return {
        sessionFile: path.join(controller.agentDir, "sessions", "fresh-chat.jsonl"),
        sessionId: "session-1",
      };
    },
    runCommand: async (commandLine) => {
      calls.push(`runCommand:${commandLine}`);
      return { handled: true, text: "Session stats" };
    },
  };

  await controller.runCommand("/session");

  assert.deepEqual(calls, ["ensureSessionReady", "runCommand:/session"]);
  assert.deepEqual(deliveries, ["Session stats"]);
  assert.equal(controller.state.piSessionFile, "fresh-chat.jsonl");
});

test("chat controller skips recovery bootstrap for /new", async () => {
  const controller = await createController();
  const calls = [];
  const deliveries = [];
  controller.commitPendingDelivery = async function () {
    deliveries.push(this.state.pendingDelivery?.text || "");
    delete this.state.pendingDelivery;
    this.saveState();
  };

  controller.connect = async function (options = {}) {
    calls.push(`connect:${String(options.restoreSession)}`);
    this.session = {
      sessionManager: {
        getSessionFile: () => path.join(controller.agentDir, "sessions", "new-chat.jsonl"),
        getSessionId: () => "session-2",
        getSessionName: () => this.chatKey,
      },
      ensureSessionReady: async () => {
        calls.push("ensureSessionReady");
        return {
          sessionFile: path.join(controller.agentDir, "sessions", "new-chat.jsonl"),
          sessionId: "session-2",
        };
      },
      runCommand: async (commandLine) => {
        calls.push(`runCommand:${commandLine}`);
        return { handled: true, text: "Started a new session." };
      },
    };
  };

  await controller.runCommand("/new");

  assert.deepEqual(calls, ["connect:false", "runCommand:/new"]);
  assert.deepEqual(deliveries, ["Started a new session."]);
  assert.equal(controller.state.piSessionFile, "new-chat.jsonl");
});

test("chat controller delivers visible non-transient command errors", async () => {
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
      getSessionName: () => controller.chatKey,
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

test("chat controller keeps transient daemon command errors out of chat replies", async () => {
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
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      throw new Error("connect ENOENT /run/user/1001/rin-daemon/daemon.sock");
    },
    runCommand: async () => ({ handled: true, text: "unreachable" }),
  };

  await assert.rejects(
    controller.runCommand("/reload"),
    /connect ENOENT \/run\/user\/1001\/rin-daemon\/daemon.sock/,
  );
  assert.deepEqual(deliveries, []);
});

test("chat controller polls typing and rotating reactions while a turn is active", async () => {
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

  controller.state.processing = {
    text: "hello",
    attachments: [],
    startedAt: Date.now(),
    incomingMessageId: "m1",
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🌘"]]);

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🌘"]]);
});

test("chat controller uses a fixed Working notice policy for onebot private chats", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  controller.sendWorkingNotice = async function () {
    if (this.state.processing?.workingNoticeSent) return false;
    deliveries.push({
      replyToMessageId: this.state.processing?.incomingMessageId,
      text: "Working……",
    });
    if (this.state.processing) this.state.processing.workingNoticeSent = true;
    return true;
  };

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
  assert.deepEqual(deliveries, [{ replyToMessageId: "m1", text: "Working……" }]);
});

test("chat controller treats rpc completion as the canonical final reply for prompt turns", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.state.pendingDelivery?.text || "",
      replyToMessageId: this.state.pendingDelivery?.replyToMessageId,
    });
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-turn",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(controller.agentDir, "sessions", "prompt-chat.jsonl");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-prompt",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({ sessionFile, sessionId: "session-prompt" }),
    prompt: async (_text, options = {}) => {
      controller.handleSessionEvent({ type: "agent_start" });
      const during = getChatMessage(controller.agentDir, chatKey, "m-turn");
      assert.ok(during?.acceptedAt);
      assert.equal(during?.processedAt, undefined);
      controller.session.messages = [
        { role: "assistant", content: [{ type: "text", text: "history text" }] },
      ];
      emitRpcTurnComplete(controller, options, "canonical final", {
        messages: [{ type: "text", text: "result final" }],
      });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-turn",
    replyToMessageId: "m-turn",
  });

  assert.equal(result.finalText, "canonical final");
  assert.deepEqual(deliveries, [
    { text: "canonical final", replyToMessageId: "m-turn" },
  ]);
  const stored = getChatMessage(controller.agentDir, chatKey, "m-turn");
  assert.ok(stored?.acceptedAt);
  assert.ok(stored?.processedAt);
  assert.equal(stored?.sessionFile, "prompt-chat.jsonl");
  assert.equal(controller.state.piSessionFile, "prompt-chat.jsonl");
});

test("chat controller switches to a linked reply session before sending the prompt", async () => {
  const controller = await createController("telegram/1:2");
  const operations = [];
  const linkedSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "reply-linked.jsonl",
  );

  await fs.mkdir(path.dirname(linkedSessionFile), { recursive: true });
  await fs.writeFile(linkedSessionFile, "{}\n", "utf8");

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  let currentSessionFile = path.join(
    controller.agentDir,
    "sessions",
    "current-chat.jsonl",
  );

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => currentSessionFile,
      getSessionId: () => "session-linked",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => {
      operations.push("ensureSessionReady");
      return { sessionFile: linkedSessionFile, sessionId: "session-linked" };
    },
    switchSession: async (sessionFile) => {
      operations.push(`switchSession:${sessionFile}`);
      currentSessionFile = sessionFile;
    },
    prompt: async (_text, options = {}) => {
      operations.push("prompt");
      emitRpcTurnComplete(controller, options, "continued there");
    },
  };

  await controller.runTurn({
    text: "continue",
    attachments: [],
    sessionFile: linkedSessionFile,
  });

  assert.deepEqual(operations, [
    `switchSession:${linkedSessionFile}`,
    "ensureSessionReady",
    "prompt",
  ]);
  assert.equal(controller.state.piSessionFile, "reply-linked.jsonl");
});

test("chat controller steers an already streaming session instead of waiting for a new owned turn", async () => {
  const controller = await createController("telegram/1:2");
  const promptCalls = [];

  controller.session = {
    isStreaming: true,
    sessionManager: {
      getSessionFile: () => "/tmp/live-chat.jsonl",
      getSessionId: () => "session-live",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/live-chat.jsonl",
      sessionId: "session-live",
    }),
    prompt: async (text, options = {}) => {
      promptCalls.push({ text, streamingBehavior: options.streamingBehavior });
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "follow up",
    attachments: [],
    incomingMessageId: "m-steer",
  });

  assert.deepEqual(promptCalls, [
    { text: "follow up", streamingBehavior: "steer" },
  ]);
  assert.equal(result.steered, true);
});

test("chat controller does not let presentation polling block prompt submission", async () => {
  const controller = await createController("onebot/1:2");
  const calls = [];
  controller.pollTyping = async function () {
    calls.push("pollTyping");
    await new Promise(() => {});
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    delete this.state.pendingDelivery;
    if (clearProcessing) delete this.state.processing;
    this.saveState();
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/nonblocking-chat.jsonl",
      getSessionId: () => "session-nonblocking",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/nonblocking-chat.jsonl",
      sessionId: "session-nonblocking",
    }),
    prompt: async (_text, options = {}) => {
      calls.push("prompt");
      emitRpcTurnComplete(controller, options, "ok");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-nonblocking",
  });

  assert.equal(result.finalText, "ok");
  assert.deepEqual(calls, ["pollTyping", "prompt"]);
});
