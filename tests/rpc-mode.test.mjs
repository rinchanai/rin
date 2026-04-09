import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { runCustomRpcMode } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("rpc mode routes interrupt_prompt through session.prompt with steer behavior", async () => {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map();
  const lines = [];
  const calls = [];

  process.stdin.on = function (event, handler) {
    handlers.set(event, handler);
    return this;
  };
  process.stdout.write = function (chunk) {
    lines.push(String(chunk));
    return true;
  };

  try {
    const session = {
      isStreaming: false,
      isCompacting: false,
      sessionFile: "/tmp/test-session.jsonl",
      agent: { waitForIdle: async () => {} },
      bindExtensions: async () => {},
      subscribe: () => {},
      prompt: async (message, options) => {
        calls.push(["prompt", message, options]);
      },
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        getEntries: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => process.cwd(),
      },
      messages: [],
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () => "",
      setThinkingLevel: () => {},
      cycleThinkingLevel: () => undefined,
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      compact: async () => {},
      setAutoCompactionEnabled: () => {},
      setAutoRetryEnabled: () => {},
      abortRetry: () => {},
      executeBash: async () => {},
      abortBash: async () => {},
      fork: async () => ({ cancelled: false, selectedText: "" }),
      navigateTree: async () => ({ cancelled: false }),
      exportToHtml: async () => "",
      exportToJsonl: () => "",
      importFromJsonl: async () => true,
      newSession: async () => true,
      switchSession: async () => true,
      setModel: async () => {},
      reload: async () => {},
      setSessionName: () => {},
    };

    void runCustomRpcMode(session, {
      SessionManager: {
        listAll: async () => [],
        list: async () => [],
        open: () => ({ appendSessionInfo() {} }),
      },
      builtinSlashCommands: [],
    });
    await wait(0);

    const onData = handlers.get("data");
    assert.equal(typeof onData, "function");
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "1", type: "interrupt_prompt", message: "hello", images: ["img"], requestTag: "tag-1" })}\n`,
      ),
    );
    await wait(10);

    assert.deepEqual(calls, [
      [
        "prompt",
        "hello",
        {
          images: ["img"],
          streamingBehavior: "steer",
          source: "rpc",
        },
      ],
    ]);
    assert.ok(lines.join("").includes('"command":"interrupt_prompt"'));
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
});

test("rpc mode rebinds to runtime.session after session replacement", async () => {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map();
  const lines = [];
  const prompts = [];
  const bindCalls = [];
  let currentSession;
  let unsubscribeCount = 0;

  process.stdin.on = function (event, handler) {
    handlers.set(event, handler);
    return this;
  };
  process.stdout.write = function (chunk) {
    lines.push(String(chunk));
    return true;
  };

  try {
    const createSession = (name) => ({
      name,
      isStreaming: false,
      isCompacting: false,
      sessionFile: `/tmp/${name}.jsonl`,
      sessionId: `${name}-id`,
      agent: { waitForIdle: async () => {} },
      bindExtensions: async () => {
        bindCalls.push(name);
      },
      subscribe: () => () => {
        unsubscribeCount += 1;
      },
      prompt: async (message, options) => {
        prompts.push([name, message, options]);
      },
      sendCustomMessage: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        getEntries: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => process.cwd(),
      },
      messages: [],
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () => "",
      setThinkingLevel: () => {},
      cycleThinkingLevel: () => undefined,
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      compact: async () => {},
      setAutoCompactionEnabled: () => {},
      setAutoRetryEnabled: () => {},
      abortRetry: () => {},
      executeBash: async () => {},
      abortBash: async () => {},
      fork: async () => ({ cancelled: false, selectedText: "" }),
      navigateTree: async () => ({ cancelled: false }),
      exportToHtml: async () => "",
      exportToJsonl: () => "",
      importFromJsonl: async () => ({ cancelled: false }),
      setModel: async () => {},
      reload: async () => {},
      setSessionName: () => {},
    });

    currentSession = createSession("first");
    const runtime = {
      get session() {
        return currentSession;
      },
      async newSession() {
        currentSession = createSession("second");
        return { cancelled: false };
      },
      async switchSession() {
        throw new Error("unexpected");
      },
      async fork() {
        throw new Error("unexpected");
      },
      async importFromJsonl() {
        throw new Error("unexpected");
      },
    };

    void runCustomRpcMode(runtime, {
      SessionManager: {
        listAll: async () => [],
        list: async () => [],
        open: () => ({ appendSessionInfo() {} }),
      },
      builtinSlashCommands: [],
    });
    await wait(0);

    const onData = handlers.get("data");
    assert.equal(typeof onData, "function");
    onData(Buffer.from(`${JSON.stringify({ id: "3", type: "new_session" })}\n`));
    await wait(20);
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "4", type: "prompt", message: "after swap", requestTag: "tag-4" })}\n`,
      ),
    );
    await wait(20);

    assert.deepEqual(bindCalls, ["first", "second"]);
    assert.equal(unsubscribeCount, 1);
    assert.deepEqual(prompts, [
      [
        "second",
        "after swap",
        { images: undefined, streamingBehavior: undefined, source: "rpc" },
      ],
    ]);
    assert.ok(lines.join("").includes('"id":"3"'));
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
});

test("rpc mode resumes interrupted tool turns by appending interrupted tool results and continuing", async () => {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map();
  const lines = [];
  const calls = [];

  process.stdin.on = function (event, handler) {
    handlers.set(event, handler);
    return this;
  };
  process.stdout.write = function (chunk) {
    lines.push(String(chunk));
    return true;
  };

  try {
    const stateMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
        ],
      },
    ];
    const session = {
      isStreaming: false,
      isCompacting: false,
      sessionFile: "/tmp/test-session.jsonl",
      agent: {
        waitForIdle: async () => {},
        state: { messages: stateMessages },
        continue: async () => {
          calls.push(["continue"]);
        },
      },
      bindExtensions: async () => {},
      subscribe: () => {},
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        appendMessage: (message) => {
          calls.push(["appendMessage", message]);
        },
        getEntries: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => process.cwd(),
      },
      messages: [],
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () => "",
      setThinkingLevel: () => {},
      cycleThinkingLevel: () => undefined,
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      compact: async () => {},
      setAutoCompactionEnabled: () => {},
      setAutoRetryEnabled: () => {},
      abortRetry: () => {},
      executeBash: async () => {},
      abortBash: async () => {},
      fork: async () => ({ cancelled: false, selectedText: "" }),
      navigateTree: async () => ({ cancelled: false }),
      exportToHtml: async () => "",
      exportToJsonl: () => "",
      importFromJsonl: async () => true,
      newSession: async () => true,
      switchSession: async () => true,
      setModel: async () => {},
      reload: async () => {},
      setSessionName: () => {},
    };

    void runCustomRpcMode(session, {
      SessionManager: {
        listAll: async () => [],
        list: async () => [],
        open: () => ({ appendSessionInfo() {} }),
      },
      builtinSlashCommands: [],
    });
    await wait(0);

    const onData = handlers.get("data");
    assert.equal(typeof onData, "function");
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "2", type: "resume_interrupted_turn", requestTag: "tag-2", source: "rpc-reconnect" })}\n`,
      ),
    );
    await wait(10);

    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "appendMessage");
    assert.equal(calls[0][1].role, "toolResult");
    assert.equal(calls[0][1].toolCallId, "tool-1");
    assert.equal(calls[0][1].toolName, "bash");
    assert.equal(calls[0][1].isError, true);
    assert.equal(
      calls[0][1].content[0].text,
      "The tool was interrupted by a daemon restart or disconnect.",
    );
    assert.deepEqual(calls[0][1].details, {
      interrupted: true,
      reason: "daemon_restart_or_disconnect",
    });
    assert.deepEqual(calls[1], ["continue"]);
    assert.equal(stateMessages.length, 2);
    assert.equal(stateMessages[1].role, "toolResult");
    assert.ok(lines.join("").includes('"command":"resume_interrupted_turn"'));
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
});
