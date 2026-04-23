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
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
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
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
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
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
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
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
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

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [{ chat_id: "2", action: "typing" }]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);

  assert.equal(await controller.pollTyping(), true);
  assert.deepEqual(actions, [
    { chat_id: "2", action: "typing" },
    { chat_id: "2", action: "typing" },
  ]);
  assert.deepEqual(reactions, [["create", "2", "m1", "🤔"]]);
});

test("chat controller flushes a completed interim assistant message before a later distinct final reply", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-interim",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(controller.agentDir, "sessions", "interim-chat.jsonl");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({ sessionFile, sessionId: "session-interim" }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先查一下" }],
        },
      });
      emitRpcTurnComplete(controller, options, "最终答复");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-interim",
    replyToMessageId: "m-interim",
  });

  assert.equal(result.finalText, "最终答复");
  assert.deepEqual(deliveries, [
    { text: "··· 我先查一下", replyToMessageId: "m-interim" },
    { text: "最终答复", replyToMessageId: "m-interim" },
  ]);
});

test("chat controller promotes assistant message updates to interim when a tool boundary follows", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-update",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(controller.agentDir, "sessions", "interim-update-chat.jsonl");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-update",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-update",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先查一下" }],
        },
      });
      await controller.handleSessionEvent({
        type: "tool_execution_start",
        toolName: "read",
      });
      emitRpcTurnComplete(controller, options, "最终答复");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-update",
    replyToMessageId: "m-update",
  });

  assert.equal(result.finalText, "最终答复");
  assert.deepEqual(deliveries, [
    { text: "··· 我先查一下", replyToMessageId: "m-update" },
    { text: "最终答复", replyToMessageId: "m-update" },
  ]);
});

test("chat controller does not leak a buffered preview as interim before the final reply", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-preview",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(controller.agentDir, "sessions", "interim-preview-chat.jsonl");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-preview",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-preview",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先查一下" }],
        },
      });
      emitRpcTurnComplete(controller, options, "最终答复");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-preview",
    replyToMessageId: "m-preview",
  });

  assert.equal(result.finalText, "最终答复");
  assert.deepEqual(deliveries, [
    { text: "最终答复", replyToMessageId: "m-preview" },
  ]);
});

test("chat controller does not emit growing final-answer prefixes as interim replies", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  saveChatMessage(controller.agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-prefixes",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello",
  });

  const sessionFile = path.join(controller.agentDir, "sessions", "interim-prefixes-chat.jsonl");
  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-interim-prefixes",
      getSessionName: () => chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile,
      sessionId: "session-interim-prefixes",
    }),
    prompt: async (_text, options = {}) => {
      await controller.handleSessionEvent({ type: "agent_start" });
      for (const text of ["我", "我先", "我先查", "我先查一下"]) {
        await controller.handleSessionEvent({
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        });
      }
      emitRpcTurnComplete(controller, options, "我先查一下，结果如下");
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-prefixes",
    replyToMessageId: "m-prefixes",
  });

  assert.equal(result.finalText, "我先查一下，结果如下");
  assert.deepEqual(deliveries, [
    { text: "我先查一下，结果如下", replyToMessageId: "m-prefixes" },
  ]);
});

test("chat controller uses a fixed Working notice policy for onebot private chats", async () => {
  const controller = await createController("onebot/1:private:2");
  const deliveries = [];
  controller.sendWorkingNotice = async function () {
    if (this.currentTurn?.workingNoticeSent) return false;
    deliveries.push({
      replyToMessageId: this.currentTurn?.incomingMessageId,
      text: "Working……",
    });
    if (this.currentTurn) this.currentTurn.workingNoticeSent = true;
    return true;
  };

  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    workingNoticeSent: false,
  };
  const liveTurn = controller.startLiveTurn();
  liveTurn.promise.catch(() => {});

  assert.equal(await controller.pollTyping(), true);
  assert.equal(await controller.pollTyping(), false);
  assert.equal(controller.currentTurn.workingNoticeSent, true);
  assert.deepEqual(deliveries, [{ replyToMessageId: "m1", text: "Working……" }]);
});

test("chat controller does not keep typing from stale currentTurn metadata alone", async () => {
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
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-stale",
    workingNoticeSent: false,
  };

  assert.equal(await controller.pollTyping(), false);
  assert.deepEqual(actions, []);
  assert.deepEqual(reactions, []);
});

test("chat controller clears the working reaction before dropping processing state", async () => {
  const controller = await createController("telegram/1:2");
  const reactions = [];
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async deleteReaction(chatId, messageId, emoji, userId) {
          reactions.push(["delete", chatId, messageId, emoji, userId]);
        },
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m-finished",
    workingNoticeSent: false,
  };
  controller.workingReactionEmoji = "🤔";
  controller.workingReactionTick = 1;
  controller.lastWorkingReactionAt = Date.now();
  controller.awaitingTurnSettle = true;
  controller.stagedDelivery = {
    type: "text_delivery",
    chatKey: controller.chatKey,
    text: "pending",
  };

  await controller.clearProcessingState();

  assert.deepEqual(reactions, [["delete", "2", "m-finished", "🤔", "1"]]);
  assert.equal(controller.currentTurn, null);
  assert.equal(controller.workingReactionEmoji, "");
  assert.equal(controller.workingReactionTick, 0);
  assert.equal(controller.lastWorkingReactionAt, 0);
  assert.equal(controller.awaitingTurnSettle, false);
  assert.equal(controller.stagedDelivery, null);
});

test("chat controller treats rpc completion as the canonical final reply for prompt turns", async () => {
  const controller = await createController("telegram/1:2");
  const chatKey = "telegram/1:2";
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
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

test(
  "chat controller reuses an observed completed assistant message when rpc finalText is missing",
  async () => {
    const controller = await createController("telegram/1:2");
    const deliveries = [];
    controller.commitPendingDelivery = async function (clearProcessing = false) {
      deliveries.push({
        text: this.stagedDelivery?.text || "",
        replyToMessageId: this.stagedDelivery?.replyToMessageId,
      });
      this.stagedDelivery = null;
      if (clearProcessing) this.currentTurn = null;
    };

    controller.session = {
      isStreaming: false,
      messages: [],
      sessionManager: {
        getSessionFile: () => "/tmp/rpc-result-chat.jsonl",
        getSessionId: () => "session-rpc-result",
        getSessionName: () => "telegram/1:2",
      },
      ensureSessionReady: async () => ({
        sessionFile: "/tmp/rpc-result-chat.jsonl",
        sessionId: "session-rpc-result",
      }),
      prompt: async (_text, options = {}) => {
        await controller.handleSessionEvent({ type: "agent_start" });
        await controller.handleSessionEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "observed completed text" }],
          },
        });
        emitRpcTurnComplete(controller, options, "", {
          messages: [{ type: "text", text: "canonical result text" }],
        });
      },
      switchSession: async () => {},
    };

    const result = await controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-turn-observed-final",
      replyToMessageId: "m-turn-observed-final",
    });

    assert.equal(result.finalText, "observed completed text");
    assert.deepEqual(deliveries, [
      {
        text: "observed completed text",
        replyToMessageId: "m-turn-observed-final",
      },
    ]);
  },
);

test("chat controller rejects rpc completion without canonical finalText", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "canonical session text" }],
      },
    ],
    sessionManager: {
      getSessionFile: () => "/tmp/rpc-result-chat.jsonl",
      getSessionId: () => "session-rpc-result",
      getSessionName: () => "telegram/1:2",
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/rpc-result-chat.jsonl",
      sessionId: "session-rpc-result",
    }),
    prompt: async (_text, options = {}) => {
      controller.handleSessionEvent({ type: "agent_start" });
      emitRpcTurnComplete(controller, options, "", {
        messages: [{ type: "text", text: "canonical result text" }],
      });
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-turn-missing-final",
      replyToMessageId: "m-turn-missing-final",
    }),
    /rpc_turn_final_output_missing/,
  );

  assert.deepEqual(deliveries, []);
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
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
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

test("chat controller lets steer bypass the owned turn queue while the current turn is still streaming", async () => {
  const controller = await createController("telegram/1:2");
  const promptCalls = [];
  const deliveries = [];
  let releaseFirstPrompt = () => {};
  let firstRequestTag = "";
  let resolveFirstPromptStarted = () => {};
  const firstPromptStarted = new Promise((resolve) => {
    resolveFirstPromptStarted = resolve;
  });

  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push(this.stagedDelivery?.text || "");
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
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
      if (options.streamingBehavior === "steer") return;
      firstRequestTag = String(options.requestTag || "");
      controller.session.isStreaming = true;
      resolveFirstPromptStarted();
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
      controller.session.isStreaming = false;
      emitRpcTurnComplete(controller, { requestTag: firstRequestTag }, "done");
    },
    switchSession: async () => {},
  };

  const firstTurn = controller.runTurn({
    text: "first",
    attachments: [],
    incomingMessageId: "m-first",
  });
  await firstPromptStarted;

  const steerResult = await controller.runTurn(
    {
      text: "steer now",
      attachments: [],
      incomingMessageId: "m-steer-now",
    },
    "steer",
  );

  assert.equal(steerResult.steered, true);
  assert.deepEqual(promptCalls, [
    { text: "first", streamingBehavior: undefined },
    { text: "steer now", streamingBehavior: "steer" },
  ]);

  releaseFirstPrompt();
  const firstResult = await firstTurn;
  assert.equal(firstResult.finalText, "done");
  assert.deepEqual(deliveries, ["done"]);
});

test("chat controller drops superseded pending assistant text before steer", async () => {
  const controller = await createController("telegram/1:2");
  const deliveries = [];
  let firstPromptOptions;

  controller.deliverAssistantInterim = async function (text) {
    deliveries.push({
      text: `··· ${text}`,
      replyToMessageId: this.currentReplyToMessageId(),
    });
    return true;
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    deliveries.push({
      text: this.stagedDelivery?.text || "",
      replyToMessageId: this.stagedDelivery?.replyToMessageId,
    });
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
  };

  controller.session = {
    isStreaming: false,
    messages: [],
    sessionManager: {
      getSessionFile: () => "/tmp/steer-final-chat.jsonl",
      getSessionId: () => "session-steer-final",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/steer-final-chat.jsonl",
      sessionId: "session-steer-final",
    }),
    prompt: async (_text, options = {}) => {
      if (options.streamingBehavior === "steer") {
        controller.session.isStreaming = false;
        emitRpcTurnComplete(controller, firstPromptOptions, "steer 后最终答复");
        return;
      }

      firstPromptOptions = options;
      controller.session.isStreaming = true;
      await controller.handleSessionEvent({ type: "agent_start" });
      await controller.handleSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "被 steer 取代的旧答复" }],
        },
      });
      await controller.runTurn(
        {
          text: "interrupt",
          attachments: [],
          incomingMessageId: "m-steer-new",
          replyToMessageId: "m-steer-old",
        },
        "steer",
      );
    },
    switchSession: async () => {},
  };

  const result = await controller.runTurn({
    text: "hello",
    attachments: [],
    incomingMessageId: "m-steer-old",
    replyToMessageId: "m-steer-old",
  });

  assert.equal(result.finalText, "steer 后最终答复");
  assert.deepEqual(deliveries, [
    { text: "steer 后最终答复", replyToMessageId: "m-steer-old" },
  ]);
});

test("chat controller fails fast when prompt submission is queued offline instead of hanging forever", async () => {
  const controller = await createController("telegram/1:2");
  controller.session = {
    isStreaming: false,
    messages: [],
    queuedOfflineOps: [],
    syncPendingCount() {},
    emitFrontendStatus() {},
    sessionManager: {
      getSessionFile: () => "/tmp/offline-chat.jsonl",
      getSessionId: () => "session-offline",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/offline-chat.jsonl",
      sessionId: "session-offline",
    }),
    prompt: async (_text, options = {}) => {
      controller.session.queuedOfflineOps.push({ requestTag: options.requestTag });
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-offline",
    }),
    /rin_disconnected:rpc_turn_queued_offline/,
  );
});

test("chat controller releases a stale bound session after transient prompt timeout", async () => {
  const controller = await createController("telegram/1:2");
  await fs.mkdir(path.join(controller.agentDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(controller.agentDir, "sessions", "stale-chat.jsonl"),
    '{"type":"session","version":3}\n',
    "utf8",
  );
  controller.state.piSessionFile = "stale-chat.jsonl";
  let disposed = 0;
  controller.driver.dispose = function () {
    disposed += 1;
    this.session = null;
  };
  controller.session = {
    isStreaming: false,
    messages: [],
    queuedOfflineOps: [],
    syncPendingCount() {},
    emitFrontendStatus() {},
    sessionManager: {
      getSessionFile: () => "/tmp/stale-chat.jsonl",
      getSessionId: () => "session-stale",
      getSessionName: () => controller.chatKey,
    },
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/stale-chat.jsonl",
      sessionId: "session-stale",
    }),
    prompt: async () => {
      throw new Error("rin_timeout:prompt");
    },
    switchSession: async () => {},
  };

  await assert.rejects(
    controller.runTurn({
      text: "hello",
      attachments: [],
      incomingMessageId: "m-timeout",
    }),
    /rin_timeout:prompt/,
  );

  assert.equal(controller.state.piSessionFile, undefined);
  assert.equal(disposed, 1);
});


test("chat controller does not let presentation polling block prompt submission", async () => {
  const controller = await createController("onebot/1:2");
  const calls = [];
  controller.pollTyping = async function () {
    calls.push("pollTyping");
    await new Promise(() => {});
  };
  controller.commitPendingDelivery = async function (clearProcessing = false) {
    this.stagedDelivery = null;
    if (clearProcessing) this.currentTurn = null;
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

test("chat controller does not persist transient processing state to chat state.json", async () => {
  const controller = await createController("telegram/1:2");
  const statePath = controller.statePath;
  controller.currentTurn = {
    startedAt: Date.now(),
    incomingMessageId: "m1",
    replyToMessageId: "m1",
    workingNoticeSent: false,
  };
  controller.stagedDelivery = {
    type: "text_delivery",
    chatKey: controller.chatKey,
    text: "hello",
    replyToMessageId: "m1",
    sessionFile: "/tmp/demo.jsonl",
  };
  controller.state.piSessionFile = "/tmp/demo.jsonl";

  controller.saveState();

  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(persisted, {
    chatKey: controller.chatKey,
    piSessionFile: "/tmp/demo.jsonl",
  });
  assert.equal(controller.currentTurn?.incomingMessageId, "m1");
  assert.equal(controller.stagedDelivery?.text, "hello");
});
