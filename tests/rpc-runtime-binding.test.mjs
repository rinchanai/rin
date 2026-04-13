import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRpcState(overrides = {}) {
  return {
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionFile: "/tmp/current.jsonl",
    sessionId: "current-id",
    sessionName: "Current Session",
    autoCompactionEnabled: false,
    pendingMessageCount: 0,
    ...overrides,
  };
}

function createRpcRuntimeHarness(options = {}) {
  let state = createRpcState(options.state);
  let messages = options.messages ?? [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  let entries = options.entries ?? [
    {
      id: "entry-1",
      parentId: null,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      id: "entry-2",
      parentId: "entry-1",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    },
  ];
  let tree = options.tree ?? [
    {
      entry: { id: "entry-1" },
      label: "Start",
      children: [{ entry: { id: "entry-2" }, label: "Reply", children: [] }],
    },
  ];
  let leafId = options.leafId ?? "entry-2";
  let connected = options.connected ?? true;
  let listSessionsResponse = options.listSessionsResponse ?? [
    { id: "resume-id", path: "/tmp/resume.jsonl", name: "Resume target" },
  ];
  const sent = [];
  const aborts = [];
  const disconnects = [];
  const renamed = [];
  const remoteNames = [];
  const labels = [];

  const refreshMessages = (assistantText) => {
    messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: assistantText }] },
    ];
    entries = [
      {
        id: "entry-1",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        id: "entry-2",
        parentId: "entry-1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      },
    ];
    leafId = "entry-2";
  };

  const client = {
    async send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "get_state":
          return { success: true, data: { ...state } };
        case "get_messages":
          return { success: true, data: { messages } };
        case "get_session_entries":
          return { success: true, data: { entries } };
        case "get_session_tree":
          return { success: true, data: { tree, leafId } };
        case "get_available_models":
          return {
            success: true,
            data: {
              models: [
                { provider: "openai", id: "gpt-5" },
                { provider: "anthropic", id: "claude-sonnet" },
              ],
            },
          };
        case "get_oauth_state":
          return {
            success: true,
            data: {
              credentials: { github: { type: "oauth" } },
              providers: [
                { id: "github", name: "GitHub", usesCallbackServer: true },
              ],
            },
          };
        case "new_session":
          state = createRpcState({
            sessionFile: "/tmp/new-session.jsonl",
            sessionId: "new-session-id",
            sessionName: "New Session",
          });
          refreshMessages("new session ready");
          return { success: true, data: { cancelled: false } };
        case "switch_session":
          state = createRpcState({
            sessionFile: payload.sessionPath,
            sessionId: "switched-session-id",
            sessionName: "Switched Session",
          });
          refreshMessages("switched session ready");
          return { success: true, data: { cancelled: false } };
        case "rename_session":
          renamed.push([payload.sessionPath, payload.name]);
          if (payload.sessionPath === state.sessionFile) {
            state = { ...state, sessionName: String(payload.name).trim() };
          }
          return { success: true, data: {} };
        case "set_session_name":
          remoteNames.push(payload.name);
          state = { ...state, sessionName: String(payload.name).trim() };
          return { success: true, data: {} };
        case "set_entry_label":
          labels.push([payload.entryId, payload.label, payload.sessionFile]);
          tree = [
            {
              entry: { id: "entry-1" },
              label: payload.label,
              children: [
                { entry: { id: "entry-2" }, label: "Reply", children: [] },
              ],
            },
          ];
          return { success: true, data: {} };
        case "list_sessions":
          return { success: true, data: { sessions: listSessionsResponse } };
        case "compact":
          refreshMessages("compacted summary");
          return { success: true, data: { summary: "compacted" } };
        case "bash":
          refreshMessages("bash completed");
          return { success: true, data: { exitCode: 0, stdout: "done" } };
        case "fork":
          refreshMessages("fork completed");
          return {
            success: true,
            data: { cancelled: false, text: "forked text" },
          };
        case "navigate_tree":
          refreshMessages("tree navigated");
          leafId = String(payload.targetId);
          return {
            success: true,
            data: {
              cancelled: false,
              aborted: false,
              editorText: "summary text",
              summaryEntry: { id: "summary-1" },
            },
          };
        case "export_html":
          return { success: true, data: { path: "/tmp/export.html" } };
        case "export_jsonl":
          return { success: true, data: { path: "/tmp/export.jsonl" } };
        case "import_jsonl":
          state = createRpcState({
            sessionFile: "/tmp/imported.jsonl",
            sessionId: "imported-session-id",
            sessionName: "Imported Session",
          });
          refreshMessages("import completed");
          return { success: true, data: { cancelled: false } };
        case "run_command":
          refreshMessages(`ran ${payload.commandLine}`);
          return {
            success: true,
            data: { handled: true, text: `ran ${payload.commandLine}` },
          };
        default:
          throw new Error(`Unhandled payload: ${JSON.stringify(payload)}`);
      }
    },
    subscribe() {
      return () => {};
    },
    abort() {
      aborts.push("abort");
      return Promise.resolve();
    },
    isConnected() {
      return connected;
    },
    connect() {
      connected = true;
      return Promise.resolve();
    },
    disconnect() {
      connected = false;
      disconnects.push("disconnect");
      return Promise.resolve();
    },
  };

  const session = new RpcInteractiveSession(client);
  session.model = state.model;
  session.thinkingLevel = state.thinkingLevel;
  session.isStreaming = state.isStreaming;
  session.isCompacting = state.isCompacting;
  session.steeringMode = state.steeringMode;
  session.followUpMode = state.followUpMode;
  session.sessionFile = state.sessionFile;
  session.sessionId = state.sessionId;
  session.sessionName = state.sessionName;
  session.autoCompactionEnabled = state.autoCompactionEnabled;
  session.pendingMessageCount = state.pendingMessageCount;
  session.messages = messages;
  session.state.messages = messages;
  session.state.model = state.model;
  session.state.thinkingLevel = state.thinkingLevel;
  return {
    session,
    sent,
    aborts,
    disconnects,
    renamed,
    remoteNames,
    labels,
    setConnected(value) {
      connected = value;
    },
    setListSessionsResponse(value) {
      listSessionsResponse = value;
    },
  };
}

test("rpc runtime keeps control methods bound to the session instance", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  const model = { provider: "test", id: "demo-model" };
  const {
    setModel,
    setSteeringMode,
    setFollowUpMode,
    setAutoCompactionEnabled,
  } = session;

  await setModel(model);
  setSteeringMode("one-at-a-time");
  setFollowUpMode("all");
  setAutoCompactionEnabled(true);

  await waitForMicrotasks();

  assert.deepEqual(session.model, model);
  assert.deepEqual(session.state.model, model);
  assert.equal(session.steeringMode, "one-at-a-time");
  assert.equal(session.followUpMode, "all");
  assert.equal(session.settingsManager.getSteeringMode(), "one-at-a-time");
  assert.equal(session.settingsManager.getFollowUpMode(), "all");
  assert.deepEqual(
    sent.map((entry) => entry.type),
    [],
  );
});

test("rpc runtime session lifecycle methods refresh local state and preserve bindings", async () => {
  const harness = createRpcRuntimeHarness();
  const { session, sent, renamed, remoteNames, labels } = harness;

  assert.equal(await session.newSession(), true);
  assert.equal(session.sessionFile, "/tmp/new-session.jsonl");
  assert.equal(session.sessionId, "new-session-id");
  assert.equal(session.sessionName, "New Session");

  assert.equal(await session.switchSession("/tmp/switched.jsonl"), true);
  assert.equal(session.sessionFile, "/tmp/switched.jsonl");
  assert.equal(session.sessionId, "switched-session-id");

  await session.renameSession("/tmp/switched.jsonl", "  Renamed Session  ");
  await session.setSessionName("  Active Session  ");
  await session.setEntryLabel("entry-1", "Pinned");
  const listed = await session.listSessions();

  assert.deepEqual(listed, [
    { id: "resume-id", path: "/tmp/resume.jsonl", name: "Resume target" },
  ]);
  assert.deepEqual(renamed, [["/tmp/switched.jsonl", "  Renamed Session  "]]);
  assert.deepEqual(remoteNames, ["  Active Session  "]);
  assert.deepEqual(labels, [["entry-1", "Pinned", "/tmp/switched.jsonl"]]);
  assert.equal(session.sessionName, "Active Session");
  assert.equal(session.sessionManager.getLabel("entry-1"), "Pinned");

  const sentTypes = sent.map((entry) => entry.type);
  assert.ok(sentTypes.includes("new_session"));
  assert.ok(sentTypes.includes("switch_session"));
  assert.ok(sentTypes.includes("rename_session"));
  assert.ok(sentTypes.includes("set_session_name"));
  assert.ok(sentTypes.includes("set_entry_label"));
  assert.ok(sentTypes.includes("list_sessions"));
  assert.ok(sentTypes.filter((type) => type === "get_state").length >= 4);
  assert.ok(
    sentTypes.filter((type) => type === "get_session_tree").length >= 3,
  );
});

test("rpc runtime action methods map responses and attach the active session", async () => {
  const harness = createRpcRuntimeHarness();
  const { session, sent } = harness;

  assert.deepEqual(await session.compact("keep summary"), {
    summary: "compacted",
  });
  assert.deepEqual(await session.executeBash("echo hi"), {
    exitCode: 0,
    stdout: "done",
  });
  assert.deepEqual(await session.fork("entry-1"), {
    cancelled: false,
    selectedText: "forked text",
  });
  assert.deepEqual(
    await session.navigateTree("entry-2", {
      summarize: true,
      customInstructions: "focus",
      replaceInstructions: true,
      label: "Branch summary",
    }),
    {
      cancelled: false,
      aborted: false,
      editorText: "summary text",
      summaryEntry: { id: "summary-1" },
    },
  );
  assert.equal(await session.exportToHtml(), "/tmp/export.html");
  assert.equal(await session.exportToJsonl(), "/tmp/export.jsonl");
  assert.equal(await session.importFromJsonl("/tmp/in.jsonl"), true);
  assert.equal(session.sessionFile, "/tmp/imported.jsonl");
  assert.equal(session.getLastAssistantText(), "import completed");

  const compactPayload = sent.find((entry) => entry.type === "compact");
  const bashPayload = sent.find((entry) => entry.type === "bash");
  const forkPayload = sent.find((entry) => entry.type === "fork");
  const navigatePayload = sent.find((entry) => entry.type === "navigate_tree");
  const importPayload = sent.find((entry) => entry.type === "import_jsonl");

  assert.equal(compactPayload.sessionFile, "/tmp/current.jsonl");
  assert.equal(bashPayload.sessionFile, "/tmp/current.jsonl");
  assert.equal(forkPayload.sessionFile, "/tmp/current.jsonl");
  assert.equal(navigatePayload.sessionFile, "/tmp/current.jsonl");
  assert.equal(importPayload.inputPath, "/tmp/in.jsonl");
  assert.ok(sent.filter((entry) => entry.type === "get_messages").length >= 5);
  assert.ok(
    sent.filter((entry) => entry.type === "get_session_entries").length >= 5,
  );
});

test("rpc runtime runCommand handles local slash commands and remote commands coherently", async () => {
  const harness = createRpcRuntimeHarness({
    state: {
      sessionFile: undefined,
      sessionId: "",
      sessionName: undefined,
    },
  });
  const { session, sent, aborts, setListSessionsResponse } = harness;

  assert.deepEqual(await session.runCommand("/abort"), {
    handled: true,
    text: "Aborted current operation.",
  });
  assert.deepEqual(aborts, ["abort"]);

  assert.deepEqual(await session.runCommand("/new"), {
    handled: true,
    text: "Started a new session.",
  });
  assert.equal(session.sessionFile, "/tmp/new-session.jsonl");

  assert.deepEqual(await session.runCommand("/resume missing"), {
    handled: true,
    text: "Session not found: missing",
  });

  setListSessionsResponse([
    {
      id: "resume-id",
      path: "/tmp/resume-target.jsonl",
      name: "Resume target",
    },
  ]);
  assert.deepEqual(await session.runCommand("/resume resume-id"), {
    handled: true,
    text: "Resumed session: resume-id",
  });
  assert.equal(session.sessionFile, "/tmp/resume-target.jsonl");

  assert.deepEqual(await session.runCommand("/echo hi"), {
    handled: true,
    text: "ran /echo hi",
  });

  const runCommandPayload = sent.find((entry) => entry.type === "run_command");
  assert.deepEqual(runCommandPayload, {
    type: "run_command",
    commandLine: "/echo hi",
    sessionFile: "/tmp/resume-target.jsonl",
  });
  assert.ok(sent.filter((entry) => entry.type === "list_sessions").length >= 2);
});
