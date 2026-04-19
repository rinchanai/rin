import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeStringList, safeString } from "../text-utils.js";

const HOME_DIR = os.homedir();

import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import { BUILTIN_MODULE_ORDER } from "../builtins/registry.js";
import { listBoundSessions } from "../session/factory.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import {
  formatSubagentSessionRefAmbiguousError,
  formatSubagentSessionRefNotFoundError,
  formatSubagentSessionRefRequiredError,
  normalizeSubagentSessionConfig,
  type NormalizedSubagentSessionConfig,
} from "./session-utils.js";
import {
  buildModelLookup,
  getProviderSummaries,
  normalizeModelRef,
} from "./models.js";
import { getFinalOutput } from "./format-utils.js";
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

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionCreationQueue.then(fn, fn);
  sessionCreationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeDisabledExtensions(values: unknown): string[] {
  return Array.isArray(values)
    ? normalizeStringList(values, { lowercase: true })
    : [];
}

export function resolveSubagentDisabledBuiltinModules(
  disabledExtensions: string[] = [],
): string[] {
  const blocked = new Set(normalizeDisabledExtensions(disabledExtensions));
  blocked.add("subagent");
  return BUILTIN_MODULE_ORDER.filter((name) => blocked.has(name));
}

type NormalizedSubagentTask = Omit<
  SubagentTask,
  "session" | "disabledExtensions"
> & {
  session: NormalizedSubagentSessionConfig;
  disabledExtensions: string[];
};

type SessionReferenceCandidate = {
  id?: string;
  normalizedId?: string;
  path: string;
  normalizedPath: string;
};

function isPersistedMode(
  session: Pick<SubagentSessionConfig, "mode" | "keep">,
): boolean {
  const mode = (session?.mode || "memory") as SubagentSessionMode;
  if (mode === "memory") return false;
  if (mode === "fork") return session?.keep !== false;
  return true;
}

async function loadSessionManagerModule() {
  const codingAgentModule = await loadRinCodingAgent();
  return { SessionManager: (codingAgentModule as any).SessionManager };
}

function toSessionReferenceCandidates(
  sessions: Array<{ id?: unknown; path?: unknown }>,
): SessionReferenceCandidate[] {
  const candidates: SessionReferenceCandidate[] = [];
  for (const info of sessions) {
    const sessionPath = safeString(info?.path || "").trim();
    if (!sessionPath) continue;
    const sessionId = safeString(info?.id || "").trim() || undefined;
    candidates.push({
      id: sessionId,
      normalizedId: sessionId?.toLowerCase(),
      path: sessionPath,
      normalizedPath: path.resolve(sessionPath).toLowerCase(),
    });
  }
  return candidates;
}

export function selectSessionReferencePath(options: {
  ref: string;
  sessions: Array<{ id?: unknown; path?: unknown }>;
  directMatchPath?: string;
}):
  | { kind: "match"; path: string }
  | { kind: "required" | "ambiguous" | "not_found" } {
  const wanted = String(options.ref || "").trim();
  if (!wanted) return { kind: "required" };

  const candidates = toSessionReferenceCandidates(options.sessions);
  const normalizedWanted = wanted.toLowerCase();
  const normalizedDirectPath = options.directMatchPath
    ? path.resolve(options.directMatchPath).toLowerCase()
    : undefined;

  let exactIdMatch: SessionReferenceCandidate | undefined;
  let exactPathTextMatch: SessionReferenceCandidate | undefined;
  const prefixMatches: SessionReferenceCandidate[] = [];

  for (const candidate of candidates) {
    if (
      normalizedDirectPath &&
      candidate.normalizedPath === normalizedDirectPath
    ) {
      return { kind: "match", path: candidate.path };
    }
    if (!exactIdMatch && candidate.normalizedId === normalizedWanted) {
      exactIdMatch = candidate;
    }
    if (
      !exactPathTextMatch &&
      candidate.normalizedPath === normalizedWanted
    ) {
      exactPathTextMatch = candidate;
    }
    if (candidate.normalizedId?.startsWith(normalizedWanted)) {
      prefixMatches.push(candidate);
    }
  }

  if (exactIdMatch) return { kind: "match", path: exactIdMatch.path };
  if (exactPathTextMatch) {
    return { kind: "match", path: exactPathTextMatch.path };
  }
  if (prefixMatches.length === 1) {
    return { kind: "match", path: prefixMatches[0].path };
  }
  if (prefixMatches.length > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "not_found" };
}

async function resolveSessionReference(ref: string): Promise<{ path: string }> {
  const wanted = String(ref || "").trim();

  const directCandidates = wanted
    ? path.isAbsolute(wanted)
      ? [wanted]
      : [path.resolve(HOME_DIR, wanted)]
    : [];
  const directMatchPath = directCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  const { SessionManager } = await loadSessionManagerModule();
  const sessions = await listBoundSessions({
    cwd: HOME_DIR,
    SessionManager,
  });
  const match = selectSessionReferencePath({
    ref: wanted,
    sessions,
    directMatchPath,
  });

  if (match.kind === "match") {
    return { path: match.path };
  }
  if (match.kind === "required") {
    throw new Error("session_ref_required");
  }
  if (match.kind === "ambiguous") {
    throw new Error(formatSubagentSessionRefAmbiguousError(wanted));
  }
  throw new Error(formatSubagentSessionRefNotFoundError(wanted));
}

export { forkSessionManagerCompat } from "../session/fork.js";

async function createManagedSession(task: NormalizedSubagentTask) {
  const cwd = HOME_DIR;
  const sessionConfig = task.session;
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
    sessionManager = forkSessionManagerCompat(
      SessionManager,
      source.path,
      cwd,
      sessionDir,
      {
        persist: sessionConfig.keep !== false,
      },
    );
  }

  const created = await withSessionCreationLock(async () => {
    return await createConfiguredAgentSession({
      cwd: sessionManager.getCwd?.() || cwd,
      agentDir: profile.agentDir,
      disabledBuiltinModules: resolveSubagentDisabledBuiltinModules(
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

function normalizeSubagentTask(
  task: SubagentTask,
  defaults: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
  } = {},
): NormalizedSubagentTask {
  return {
    prompt: String(task.prompt || ""),
    model: normalizeModelRef(task.model) || defaults.model,
    thinkingLevel: task.thinkingLevel || defaults.thinkingLevel,
    session: normalizeSubagentSessionConfig(task.session),
    disabledExtensions: normalizeDisabledExtensions(task.disabledExtensions),
  };
}

function buildTasks(
  params: RunSubagentParams,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
): { ok: true; tasks: NormalizedSubagentTask[] } | { ok: false; error: string } {
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
      ? (params.tasks || []).map((task) => normalizeSubagentTask(task))
      : [
          normalizeSubagentTask(
            {
              prompt: String(params.prompt || ""),
              model: params.model,
              thinkingLevel: params.thinkingLevel,
              session: params.session,
              disabledExtensions: params.disabledExtensions,
            },
            {
              model: ctx.model
                ? `${ctx.model.provider}/${ctx.model.id}`
                : undefined,
              thinkingLevel: currentThinkingLevel,
            },
          ),
        ],
  };
}

function validateTasks(
  tasks: NormalizedSubagentTask[],
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
    const sessionConfig = task.session;
    if (
      (sessionConfig.mode === "resume" || sessionConfig.mode === "fork") &&
      !sessionConfig.ref
    ) {
      return formatSubagentSessionRefRequiredError(sessionConfig.mode);
    }
    if (
      (sessionConfig.mode === "memory" || sessionConfig.mode === "persist") &&
      sessionConfig.ref
    ) {
      return `Session ref is only valid with session.mode \`resume\` or \`fork\`.`;
    }
    if (
      typeof sessionConfig.keep === "boolean" &&
      sessionConfig.mode !== "fork"
    ) {
      return "session.keep is only valid with session.mode `fork`. Use session.mode `persist` to create a saved worker session.";
    }
  }
  return undefined;
}

function createEmptyUsageStats(): TaskResult["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function getSessionMessages(session: any): Message[] {
  return Array.isArray(session?.messages)
    ? (session.messages as Message[])
    : Array.isArray(session?.agent?.state?.messages)
      ? (session.agent.state.messages as Message[])
      : [];
}

export function collectTaskResultState(
  messages: Message[],
): Pick<TaskResult, "output" | "stopReason" | "errorMessage" | "model" | "usage"> {
  const usage = createEmptyUsageStats();
  let stopReason: TaskResult["stopReason"];
  let errorMessage: TaskResult["errorMessage"];
  let model: TaskResult["model"];

  for (const rawMessage of messages) {
    const message = rawMessage as any;
    if (message?.role !== "assistant") continue;
    stopReason = message.stopReason;
    errorMessage = message.errorMessage;
    if (message.model) {
      model = `${message.provider}/${message.model}`;
    }
    const currentUsage = message.usage;
    if (!currentUsage) continue;
    usage.turns += 1;
    usage.input += currentUsage.input || 0;
    usage.output += currentUsage.output || 0;
    usage.cacheRead += currentUsage.cacheRead || 0;
    usage.cacheWrite += currentUsage.cacheWrite || 0;
    usage.cost += currentUsage.cost?.total || 0;
    usage.contextTokens = currentUsage.totalTokens || usage.contextTokens;
  }

  return {
    output: getFinalOutput(messages),
    stopReason,
    errorMessage,
    model,
    usage,
  };
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

function syncResultFromMessages(messages: Message[], result: TaskResult): void {
  const state = collectTaskResultState(messages);
  result.output = state.output;
  result.stopReason = state.stopReason;
  result.errorMessage = state.errorMessage;
  result.model = state.model;
  result.usage = state.usage;
}

function syncResultFromSession(
  session: any,
  result: TaskResult,
  sinceMessageIndex = 0,
): void {
  const sessionMessages = getSessionMessages(session).slice(sinceMessageIndex);
  const resultMessages =
    sessionMessages.length > 0 ? sessionMessages : [...result.messages];

  result.messages.length = 0;
  result.messages.push(...resultMessages);
  syncSessionMetadata(session, result);
  syncResultFromMessages(result.messages, result);
}

function createTaskResult(
  task: NormalizedSubagentTask,
  index: number,
  messages: Message[] = [],
): TaskResult {
  const sessionConfig = task.session;
  return {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    status: "pending",
    exitCode: 0,
    output: "",
    usage: createEmptyUsageStats(),
    messages,
    sessionMode: sessionConfig.mode,
    sessionPersisted: isPersistedMode(sessionConfig),
  };
}

function snapshotTaskResult(result: TaskResult): TaskResult {
  return {
    ...result,
    usage: { ...result.usage },
    messages: [...result.messages],
  };
}

function emitTaskProgress(
  result: TaskResult,
  onProgress?: (result: TaskResult) => void,
): void {
  onProgress?.(snapshotTaskResult(result));
}

function setTaskResultError(result: TaskResult, error: unknown, session?: any): void {
  result.exitCode = 1;
  result.status = "error";
  result.errorMessage = String((error as any)?.message || error || "subagent_failed");
  if (session) {
    syncSessionMetadata(session, result);
  }
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
    createTaskResult(task, index + 1),
  );
  options.onProgress?.(progressResults.map(snapshotTaskResult), details);

  const results = await Promise.all(
    built.tasks.map((task, index) =>
      runSubagentTask(
        task,
        index + 1,
        options.signal,
        (partial) => {
          progressResults[index] = partial;
          options.onProgress?.(progressResults.map(snapshotTaskResult), details);
        },
      ),
    ),
  );

  return { ok: true, results, ...details };
}

export async function runSubagentTask(
  task: NormalizedSubagentTask,
  index: number,
  signal?: AbortSignal,
  onProgress?: (result: TaskResult) => void,
): Promise<TaskResult> {
  const messages: Message[] = [];
  const result = createTaskResult(task, index, messages);

  let session: any;
  let runtime: any;
  let initialMessageCount = 0;
  try {
    const created = await createManagedSession(task);
    session = created.session;
    runtime = created.runtime;
    initialMessageCount = getSessionMessages(session).length;
    syncSessionMetadata(session, result);
  } catch (error: any) {
    setTaskResultError(result, error);
    emitTaskProgress(result, onProgress);
    return result;
  }

  result.status = "running";
  emitTaskProgress(result, onProgress);
  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "message_end" || !event.message) return;
    const message = event.message as Message;
    messages.push(message);
    if (message.role !== "assistant") return;
    syncSessionMetadata(session, result);
    syncResultFromMessages(messages, result);
    emitTaskProgress(result, onProgress);
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
    syncResultFromSession(session, result, initialMessageCount);
    const failed =
      result.stopReason === "error" || result.stopReason === "aborted";
    result.exitCode = failed ? 1 : 0;
    result.status = failed ? "error" : "done";
    emitTaskProgress(result, onProgress);
    return result;
  } catch (error: any) {
    setTaskResultError(result, error, session);
    emitTaskProgress(result, onProgress);
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
