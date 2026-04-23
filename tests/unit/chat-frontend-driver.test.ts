import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { ChatFrontendDriver } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "chat-frontend-driver.js"),
  ).href,
);

function createDriver() {
  const driver = new ChatFrontendDriver();
  driver.connect = async () => {};
  driver.session = {
    isStreaming: false,
    ensureSessionReady: async () => ({
      sessionFile: "/tmp/chat-driver.jsonl",
      sessionId: "session-driver",
    }),
    switchSession: async () => {},
    sessionManager: {
      getSessionFile: () => "/tmp/chat-driver.jsonl",
      getSessionId: () => "session-driver",
    },
  };
  return driver;
}

async function emitDriverEvent(driver: any, payload: any) {
  await driver.handleClientEvent({ type: "ui", payload });
}

async function emitRpcTurnComplete(driver: any, requestTag: string, finalText: string) {
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText,
    result: {
      messages: finalText ? [{ type: "text", text: finalText }] : [],
    },
    sessionId: "session-driver",
    sessionFile: "/tmp/chat-driver.jsonl",
  });
}

test("chat frontend driver does not leak growing final-answer prefixes as interim", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    for (const text of ["我", "我先", "我先查", "我先查一下"]) {
      await emitDriverEvent(driver, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      });
    }
    await emitRpcTurnComplete(driver, options.requestTag, "我先查一下，结果如下");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "我先查一下，结果如下");
  assert.deepEqual(interimTexts, []);
});

test("chat frontend driver does not treat a preview as interim when a tool boundary follows", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "我先查一下" }],
      },
    });
    await emitDriverEvent(driver, {
      type: "tool_execution_start",
      toolName: "read",
    });
    await emitRpcTurnComplete(driver, options.requestTag, "最终答复");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "最终答复");
  assert.deepEqual(interimTexts, []);
});

test("chat frontend driver emits a completed assistant segment as interim before a later distinct final", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  driver.session.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "我先查一下" }],
      },
    });
    await emitRpcTurnComplete(driver, options.requestTag, "最终答复");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "最终答复");
  assert.deepEqual(interimTexts, ["我先查一下"]);
});
