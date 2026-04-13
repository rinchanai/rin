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

function createRpcQuerySession(overrides = {}) {
  return {
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    sessionFile: "/tmp/query-session.jsonl",
    sessionId: "query-session",
    sessionName: "demo session",
    autoCompactionEnabled: true,
    pendingMessageCount: 2,
    agent: { waitForIdle: async () => {} },
    bindExtensions: async () => {},
    subscribe: () => {},
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    extensionRunner: {
      getRegisteredCommands: () => [
        {
          invocationName: "hello",
          description: "say hello",
          sourceInfo: { extension: "demo-extension" },
        },
      ],
    },
    promptTemplates: [
      {
        name: "rewrite",
        description: "rewrite text",
        sourceInfo: { file: "/tmp/prompts/rewrite.md" },
      },
    ],
    resourceLoader: {
      getSkills: () => ({
        skills: [
          {
            name: "debug-skill",
            description: "debug issues",
            sourceInfo: { file: "/tmp/skills/debug/SKILL.md" },
          },
        ],
      }),
    },
    modelRegistry: {
      getAvailable: async () => [
        { provider: "openai", id: "gpt-5" },
        { provider: "anthropic", id: "claude-sonnet" },
      ],
      authStorage: {
        list: () => ["github", "google"],
        get: (providerId) =>
          providerId === "github"
            ? { type: "oauth", token: "secret-token" }
            : undefined,
        getOAuthProviders: () => [
          { id: "github", name: "GitHub", usesCallbackServer: true },
          { id: "google", name: "Google", usesCallbackServer: 0 },
        ],
      },
    },
    sessionManager: {
      getEntries: () => [{ id: "entry-1", role: "user" }],
      getTree: () => [{ id: "entry-1", parentId: null }],
      getLeafId: () => "entry-1",
      getCwd: () => process.cwd(),
      getSessionDir: () => process.cwd(),
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    getSessionStats: () => ({
      sessionId: "query-session",
      sessionFile: "/tmp/query-session.jsonl",
      totalMessages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolResults: 0,
      toolCalls: 0,
      tokens: { total: 10, input: 4, output: 6, cacheRead: 0, cacheWrite: 0 },
      cost: 0.01,
    }),
    getUserMessagesForForking: () => [{ role: "user", content: "hello" }],
    getLastAssistantText: () => "last assistant text",
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
    ...overrides,
  };
}

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
  "rpc mode serves read-only session query commands from the same stable surfaces",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
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
      const session = createRpcQuerySession();
      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [{ name: "help", description: "show help" }],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          [
            { id: "state", type: "get_state" },
            { id: "oauth", type: "get_oauth_state" },
            { id: "models", type: "get_available_models" },
            { id: "stats", type: "get_session_stats" },
            { id: "entries", type: "get_session_entries" },
            { id: "tree", type: "get_session_tree" },
            { id: "fork", type: "get_fork_messages" },
            { id: "last", type: "get_last_assistant_text" },
            { id: "messages", type: "get_messages" },
            { id: "commands", type: "get_commands" },
          ]
            .map((item) => JSON.stringify(item))
            .join("\n") + "\n",
        ),
      );
      await wait(100);

      const output = lines.join("");

      assert.match(output, /"id":"state"/);
      assert.match(output, /"command":"get_state"/);
      assert.match(output, /"sessionId":"query-session"/);
      assert.match(output, /"sessionName":"demo session"/);
      assert.match(output, /"pendingMessageCount":2/);
      assert.match(output, /"id":"oauth"/);
      assert.match(output, /"command":"get_oauth_state"/);
      assert.match(output, /"usesCallbackServer":false/);
      assert.doesNotMatch(output, /secret-token/);
      assert.match(output, /"id":"models"/);
      assert.match(output, /"claude-sonnet"/);
      assert.match(output, /"id":"stats"/);
      assert.match(output, /"totalMessages":2/);
      assert.match(output, /"id":"entries"/);
      assert.match(output, /"role":"user"/);
      assert.match(output, /"id":"tree"/);
      assert.match(output, /"leafId":"entry-1"/);
      assert.match(output, /"id":"fork"/);
      assert.match(output, /"content":"hello"/);
      assert.match(output, /"id":"last"/);
      assert.match(output, /"last assistant text"/);
      assert.match(output, /"id":"messages"/);
      assert.match(output, /"text":"hi"/);
      assert.match(output, /"id":"commands"/);
      assert.match(output, /"source":"builtin"/);
      assert.match(output, /"source":"extension"/);
      assert.match(output, /"source":"prompt"/);
      assert.match(output, /"source":"skill"/);
      assert.match(output, /"skill:debug-skill"/);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode reports unknown-command failures without breaking later requests",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
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
      const session = createRpcQuerySession();
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
          `${JSON.stringify({ id: "unknown", type: "definitely_unknown" })}\n`,
        ),
      );
      onData(
        Buffer.from(`${JSON.stringify({ id: "state", type: "get_state" })}\n`),
      );
      await wait(100);

      const output = lines.join("");

      assert.match(output, /"id":"unknown"/);
      assert.match(output, /"command":"definitely_unknown"/);
      assert.match(output, /"success":false/);
      assert.match(output, /Unknown command: definitely_unknown/);
      assert.match(output, /"id":"state"/);
      assert.match(output, /"command":"get_state"/);
      assert.match(output, /"success":true/);
      assert.match(output, /"sessionId":"query-session"/);
      assert.match(output, /"pendingMessageCount":2/);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);
