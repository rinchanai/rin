import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import { getBuiltinExtensionPaths } from "../../app/builtin-extensions.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import {
  buildModelLookup,
  getProviderSummaries,
  normalizeModelRef,
} from "./models.js";
import type {
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentSessionConfig,
  SubagentSessionMode,
  SubagentTask,
  TaskResult,
} from "./types.js";

export const MAX_PARALLEL_SUBAGENT_TASKS = 8;

let sessionCreationQueue: Promise<unknown> = Promise.resolve();

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionCreationQueue.then(fn, fn);
  sessionCreationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeDisabledExtensions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  )];
}

function getExtensionNameFromPath(entry: string): string {
  const normalized = entry.split(path.sep).join("/");
  const match = normalized.match(/\/extensions\/([^/]+)\/index\.(?:ts|js)$/);
  return String(match?.[1] || "").trim().toLowerCase();
}

export function resolveSubagentExtensionPaths(
  disabledExtensions: string[] = [],
): string[] {
  const blocked = new Set(normalizeDisabledExtensions(disabledExtensions));
  blocked.add("subagent");
  return getBuiltinExtensionPaths().filter((entry) => {
    const extensionName = getExtensionNameFromPath(entry);
    if (!extensionName) return true;
    return !blocked.has(extensionName);
  });
}

function normalizeSessionConfig(
  session: SubagentSessionConfig | undefined,
): Required<Pick<SubagentSessionConfig, "mode" | "keep">> &
  SubagentSessionConfig {
  const mode = (session?.mode || "memory") as SubagentSessionMode;
  return {
    mode,
    ref: String(session?.ref || "").trim() || undefined,
    name: String(session?.name || "").trim() || undefined,
    keep: Boolean(session?.keep),
  };
}

function isPersistedMode(
  session: Pick<SubagentSessionConfig, "mode" | "keep">,
): boolean {
  const mode = (session?.mode || "memory") as SubagentSessionMode;
  if (mode === "memory") return false;
  if (mode === "fork") return Boolean(session?.keep);
  return true;
}

async function loadSessionManagerModule() {
  const codingAgentModule = await loadRinCodingAgent();
  return { SessionManager: (codingAgentModule as any).SessionManager };
}

function getDefaultSessionDir() {
  const profile = resolveRuntimeProfile({ cwd: HOME_DIR });
  return getRuntimeSessionDir(profile.cwd, profile.agentDir);
}

async function resolveSessionReference(ref: string): Promise<{ path: string }> {
  const wanted = String(ref || "").trim();
  if (!wanted) throw new Error("session_ref_required");

  const directCandidates = path.isAbsolute(wanted)
    ? [wanted]
    : [path.resolve(HOME_DIR, wanted)];
  const directMatchPath = directCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  const { SessionManager } = await loadSessionManagerModule();
  const sessions = await SessionManager.listAll();
  const normalizedWanted = wanted.toLowerCase();
  const normalizedDirectPath = directMatchPath
    ? path.resolve(directMatchPath).toLowerCase()
    : undefined;

  const exactPath = sessions.find(
    (info: any) =>
      normalizedDirectPath &&
      path.resolve(String(info?.path || "")).toLowerCase() === normalizedDirectPath,
  );
  if (exactPath) return { path: String(exactPath.path || "") };

  const exactId = sessions.find(
    (info: any) => String(info?.id || "").toLowerCase() === normalizedWanted,
  );
  if (exactId) return { path: String(exactId.path || "") };

  const exactPathText = sessions.find(
    (info: any) => path.resolve(String(info?.path || "")).toLowerCase() === normalizedWanted,
  );
  if (exactPathText) return { path: String(exactPathText.path || "") };

  const prefixMatches = sessions.filter((info: any) =>
    String(info?.id || "").toLowerCase().startsWith(normalizedWanted),
  );
  if (prefixMatches.length === 1) {
    return { path: String(prefixMatches[0]?.path || "") };
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Session ref is ambiguous: ${wanted}. Inspect ${getDefaultSessionDir()} and use an exact path or a less ambiguous id prefix.`,
    );
  }

  throw new Error(
    `Session not found: ${wanted}. Inspect ${getDefaultSessionDir()} and use a session file path, exact id, or unique id prefix.`,
  );
}

async function createManagedSession(task: SubagentTask) {
  const cwd = HOME_DIR;
  const sessionConfig = normalizeSessionConfig(task.session);
  const profile = resolveRuntimeProfile({ cwd });
  const sessionDir = getRuntimeSessionDir(cwd, profile.agentDir);
  const { SessionManager } = await loadSessionManagerModule();

  let sessionManager: any;
  if (sessionConfig.mode === "memory") {
    sessionManager = SessionManager.inMemory(cwd);
  } else if (sessionConfig.mode === "persist") {
    sessionManager = SessionManager.create(cwd, sessionDir);
  } else if (sessionConfig.mode === "resume") {
    const source = await resolveSessionReference(sessionConfig.ref || "");
    sessionManager = SessionManager.open(
      source.path,
      sessionDir,
      undefined,
    );
  } else {
    const source = await resolveSessionReference(sessionConfig.ref || "");
    sessionManager = SessionManager.forkFrom(source.path, cwd, sessionDir, {
      persist: sessionConfig.keep,
    });
  }

  const created = await withSessionCreationLock(async () => {
    return await createConfiguredAgentSession({
      cwd: sessionManager.getCwd?.() || cwd,
      agentDir: profile.agentDir,
      additionalExtensionPaths: resolveSubagentExtensionPaths(
        task.disabledExtensions,
      ),
      sessionManager,
      modelRef: task.model,
      thinkingLevel: task.thinkingLevel,
    });
  });

  if (sessionConfig.name) {
    created.session.setSessionName(sessionConfig.name);
  }

  return {
    ...created,
    sessionConfig,
  };
}

export function applySubagentTaskPreferences(task: {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}) {
  return {
    modelRef: task.model,
    thinkingLevel: task.thinkingLevel,
  };
}

export async function getSubagentBackendInfo(
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
): Promise<SubagentBackendInfo> {
  return {
    backend: "in-process-session",
    currentModel: ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined,
    currentThinkingLevel,
    providers: await getProviderSummaries(ctx),
  };
}

function buildTasks(
  params: RunSubagentParams,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
): { ok: true; tasks: SubagentTask[] } | { ok: false; error: string } {
  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasSingle = Boolean(String(params.prompt || "").trim());
  if (Number(hasTasks) + Number(hasSingle) !== 1) {
    return {
      ok: false,
      error:
        "Provide exactly one mode: either `prompt` for a single subagent, or `tasks` for parallel subagents.",
    };
  }

  if (hasTasks && (params.tasks?.length || 0) > MAX_PARALLEL_SUBAGENT_TASKS) {
    return {
      ok: false,
      error: `Too many parallel tasks (${params.tasks?.length}). Max is ${MAX_PARALLEL_SUBAGENT_TASKS}.`,
    };
  }

  return {
    ok: true,
    tasks: hasTasks
      ? (params.tasks || []).map((task) => ({
          prompt: task.prompt,
          model: normalizeModelRef(task.model),
          thinkingLevel: task.thinkingLevel,
          session: normalizeSessionConfig(task.session),
          disabledExtensions: normalizeDisabledExtensions(
            task.disabledExtensions,
          ),
        }))
      : [
          {
            prompt: String(params.prompt || ""),
            model:
              normalizeModelRef(params.model) ||
              (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
            thinkingLevel: params.thinkingLevel || currentThinkingLevel,
            session: normalizeSessionConfig(params.session),
            disabledExtensions: normalizeDisabledExtensions(
              params.disabledExtensions,
            ),
          },
        ],
  };
}

function validateTasks(
  tasks: SubagentTask[],
  details: SubagentBackendInfo,
): string | undefined {
  const availableModels = buildModelLookup(details.providers);
  for (const task of tasks) {
    if (!String(task.prompt || "").trim()) {
      return "Every subagent task needs a non-empty prompt.";
    }
    if (task.model && !availableModels.has(task.model)) {
      return `Unknown or unavailable model: ${task.model}`;
    }
    const sessionConfig = normalizeSessionConfig(task.session);
    if (
      (sessionConfig.mode === "resume" || sessionConfig.mode === "fork") &&
      !sessionConfig.ref
    ) {
      return `Session ref is required when session.mode is ${sessionConfig.mode}. Inspect ${getDefaultSessionDir()} and use a session file path, exact id, or unique id prefix.`;
    }
    if (
      (sessionConfig.mode === "memory" || sessionConfig.mode === "persist") &&
      sessionConfig.ref
    ) {
      return `Session ref is only valid with session.mode \`resume\` or \`fork\`.`;
    }
    if (sessionConfig.keep && sessionConfig.mode !== "fork") {
      return "session.keep is only valid with session.mode `fork`. Use session.mode `persist` to create a saved worker session.";
    }
  }
  return undefined;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function syncSessionMetadata(session: any, result: TaskResult): void {
  const manager = session?.sessionManager;
  result.sessionPersisted = Boolean(
    manager?.isPersisted?.() && manager?.getSessionFile?.(),
  );
  result.sessionId = safeString(manager?.getSessionId?.() || "").trim() || undefined;
  result.sessionFile =
    safeString(manager?.getSessionFile?.() || "").trim() || undefined;
  result.sessionName =
    safeString(manager?.getSessionName?.() || "").trim() || undefined;
}

function syncResultFromSession(session: any, result: TaskResult): void {
  const sessionMessages = Array.isArray(session?.messages)
    ? (session.messages as Message[])
    : Array.isArray(session?.agent?.state?.messages)
      ? (session.agent.state.messages as Message[])
      : [];

  result.messages.length = 0;
  result.messages.push(...sessionMessages);
  result.output = safeString(session?.getLastAssistantText?.() || "").trim();
  syncSessionMetadata(session, result);

  for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
    const message = sessionMessages[i] as any;
    if (message?.role !== "assistant") continue;
    result.stopReason = message.stopReason;
    result.errorMessage = message.errorMessage;
    if (message.model) {
      result.model = `${message.provider}/${message.model}`;
    }
    const usage = message.usage;
    result.usage = {
      input: usage?.input || 0,
      output: usage?.output || 0,
      cacheRead: usage?.cacheRead || 0,
      cacheWrite: usage?.cacheWrite || 0,
      cost: usage?.cost?.total || 0,
      contextTokens: usage?.totalTokens || 0,
      turns: usage ? 1 : 0,
    };
    break;
  }
}

function makePendingResult(
  task: SubagentTask,
  index: number,
  _defaultCwd: string,
): TaskResult {
  const sessionConfig = normalizeSessionConfig(task.session);
  return {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    status: "pending",
    exitCode: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    messages: [] as Message[],
    sessionMode: sessionConfig.mode,
    sessionPersisted: isPersistedMode(sessionConfig),
  };
}

export async function executeSubagentRun(options: {
  params: RunSubagentParams;
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
  onProgress?: (results: TaskResult[], details: SubagentBackendInfo) => void;
}): Promise<
  | ({ ok: true; results: TaskResult[] } & SubagentBackendInfo)
  | ({ ok: false; error: string; results?: TaskResult[] } & SubagentBackendInfo)
> {
  const details = await getSubagentBackendInfo(
    options.ctx,
    options.currentThinkingLevel,
  );
  const built = buildTasks(
    options.params,
    options.ctx,
    options.currentThinkingLevel,
  );
  if (built.ok === false) {
    return { ok: false, error: built.error, ...details };
  }

  const validationError = validateTasks(built.tasks, details);
  if (validationError) {
    return { ok: false, error: validationError, ...details };
  }

  const progressResults = built.tasks.map((task, index) =>
    makePendingResult(task, index + 1, HOME_DIR),
  );
  options.onProgress?.(
    progressResults.map((item) => ({ ...item })),
    details,
  );

  const results = await Promise.all(
    built.tasks.map((task, index) =>
      runSubagentTask(
        task,
        index + 1,
        HOME_DIR,
        options.signal,
        (partial) => {
          progressResults[index] = partial;
          options.onProgress?.(
            progressResults.map((item) => ({
              ...item,
              messages: [...item.messages],
            })),
            details,
          );
        },
      ),
    ),
  );

  return { ok: true, results, ...details };
}

export async function runSubagentTask(
  task: SubagentTask,
  index: number,
  _defaultCwd: string,
  signal?: AbortSignal,
  onProgress?: (result: TaskResult) => void,
): Promise<TaskResult> {
  const messages: Message[] = [];
  const sessionConfig = normalizeSessionConfig(task.session);
  const result: TaskResult = {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    status: "pending",
    exitCode: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    messages,
    sessionMode: sessionConfig.mode,
    sessionPersisted: isPersistedMode(sessionConfig),
  };

  let session: any;
  let runtime: any;
  try {
    const created = await createManagedSession(task);
    session = created.session;
    runtime = created.runtime;
    syncSessionMetadata(session, result);
  } catch (error: any) {
    result.exitCode = 1;
    result.status = "error";
    result.errorMessage = String(error?.message || error || "subagent_failed");
    onProgress?.({ ...result, messages: [...result.messages] });
    return result;
  }

  result.status = "running";
  onProgress?.({ ...result, messages: [...result.messages] });
  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "message_end" || !event.message) return;
    const message = event.message as Message;
    messages.push(message);
    if (message.role !== "assistant") return;
    result.output = getFinalOutput(messages);
    result.stopReason = message.stopReason;
    result.errorMessage = message.errorMessage;
    syncSessionMetadata(session, result);
    if (message.model) result.model = `${message.provider}/${message.model}`;
    const usage = message.usage;
    if (usage) {
      result.usage.turns += 1;
      result.usage.input += usage.input || 0;
      result.usage.output += usage.output || 0;
      result.usage.cacheRead += usage.cacheRead || 0;
      result.usage.cacheWrite += usage.cacheWrite || 0;
      result.usage.cost += usage.cost?.total || 0;
      result.usage.contextTokens =
        usage.totalTokens || result.usage.contextTokens;
    }
    onProgress?.({ ...result, messages: [...result.messages] });
  });

  let abortListener: (() => void) | undefined;

  try {
    if (signal) {
      const onAbort = () => {
        void session.abort().catch(() => {});
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => signal.removeEventListener("abort", onAbort);
      }
    }
    await session.prompt(task.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    syncResultFromSession(session, result);
    result.output = result.output || getFinalOutput(messages);
    const failed =
      result.stopReason === "error" || result.stopReason === "aborted";
    result.exitCode = failed ? 1 : 0;
    result.status = failed ? "error" : "done";
    onProgress?.({ ...result, messages: [...result.messages] });
    return result;
  } catch (error: any) {
    result.exitCode = 1;
    result.status = "error";
    result.errorMessage = String(error?.message || error || "subagent_failed");
    syncSessionMetadata(session, result);
    onProgress?.({ ...result, messages: [...result.messages] });
    return result;
  } finally {
    abortListener?.();
    unsubscribe();
    try {
      await session?.abort?.();
    } catch {}
    try {
      await runtime?.dispose?.();
    } catch {}
  }
}
