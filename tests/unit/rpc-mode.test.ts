import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { runCustomRpcMode } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  "rpc mode emits canonical finalText on turn completion",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

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
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "final from rpc mode" }],
          };
          session.messages = [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            assistantMessage,
          ];
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
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
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "final from rpc mode");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "final from rpc mode" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode keeps canonical finalText even when session messages lag behind",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

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
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "late final text" }],
          };
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
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
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "late final text");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "late final text" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode waits one turn-completion tick for a delayed assistant message_end",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

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
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "delayed final text" }],
          };
          session.messages = [assistantMessage];
          setImmediate(() => {
            for (const handler of sessionSubscribers) {
              handler({ type: "message_end", message: assistantMessage });
            }
          });
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
        getLastAssistantText: () => "delayed final text",
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
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "delayed final text");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "delayed final text" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode routes steer through session.steer",
  { concurrency: false },
  async () => {
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
        prompt: async () => {},
        steer: async (message, images) => {
          calls.push(["steer", message, images]);
        },
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
          `${JSON.stringify({ id: "1", type: "steer", message: "hello", images: ["img"], requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(10);

      assert.deepEqual(calls, [["steer", "hello", ["img"]]]);
      assert.ok(lines.join("").includes('"command":"steer"'));
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode reuses an already-fresh worker session for the first new_session command",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let newSessionCalls = 0;

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
        sessionFile: "/tmp/fresh-session.jsonl",
        sessionId: "fresh-session-id",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
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
      };
      const runtime = {
        session,
        async newSession() {
          newSessionCalls += 1;
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
        reuseFreshSessionForInitialNewSession: true,
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(`${JSON.stringify({ id: "3", type: "new_session" })}\n`),
      );
      await wait(20);

      assert.equal(newSessionCalls, 0);
      assert.ok(lines.join("").includes('"id":"3"'));
      assert.ok(
        lines.join("").includes('"sessionFile":"/tmp/fresh-session.jsonl"'),
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode new_session response includes the rebound session selector",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let currentSession;

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
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          getEntries: () => [{ id: `${name}-header` }],
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
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "resp-1", type: "new_session" })}\n`,
        ),
      );
      await wait(20);

      const responseLine = lines.find((line) => line.includes('"id":"resp-1"'));
      assert.ok(responseLine);
      const payload = JSON.parse(responseLine);
      assert.equal(payload.success, true);
      assert.equal(payload.data.cancelled, false);
      assert.equal(payload.data.sessionFile, "/tmp/second.jsonl");
      assert.equal(payload.data.sessionId, "second-id");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode rebinds to runtime.session after session replacement",
  { concurrency: false },
  async () => {
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
      onData(
        Buffer.from(`${JSON.stringify({ id: "3", type: "new_session" })}\n`),
      );
      await wait(20);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "4", type: "prompt", message: "after swap", requestTag: "tag-4" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(bindCalls, ["first", "second"]);
      assert.equal(unsubscribeCount, 2);
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
  },
);

test(
  "rpc mode explicit interrupted-turn resume still persists interruption context before continuing",
  { concurrency: false },
  async () => {
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
      const stateMessages = [];
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

      stateMessages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
        ],
      });

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
  },
);

test(
  "rpc mode auto-resumes an interrupted turn without appending reconnect noise to the session transcript",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const calls = [];
    const lines = [];

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

      await wait(10);

      assert.deepEqual(calls, [["continue"]]);
      assert.equal(stateMessages.length, 2);
      assert.equal(stateMessages[1].role, "toolResult");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode get_state keeps turnActive true across internal non-streaming gaps",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let releasePrompt;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const promptGate = new Promise((resolve) => {
        releasePrompt = resolve;
      });
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          await promptGate;
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
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "done",
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
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(10);
      onData(Buffer.from(`${JSON.stringify({ id: "2", type: "get_state" })}\n`));
      await wait(10);
      releasePrompt();
      await wait(20);

      const responses = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((payload) => payload?.type === "response");
      const stateResponse = responses.find((payload) => payload.id === "2");
      assert.equal(stateResponse?.data?.turnActive, true);
      assert.equal(stateResponse?.data?.isStreaming, false);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);
