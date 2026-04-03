import path from "node:path";

import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import { getBuiltinExtensionPaths } from "../../app/builtin-extensions.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { createConfiguredAgentSession } from "../rin-lib/runtime.js";
import {
  buildModelLookup,
  getProviderSummaries,
  normalizeModelRef,
  splitModelRef,
} from "./models.js";
import type {
  RunSubagentParams,
  SubagentBackendInfo,
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

function getSubagentExtensionPaths(): string[] {
  return getBuiltinExtensionPaths().filter((entry) => {
    const normalized = entry.split(path.sep).join("/");
    return !normalized.endsWith("/extensions/subagent/index.ts");
  });
}

async function createIsolatedSession(cwd: string) {
  const codingAgentModule = await loadRinCodingAgent();
  const { SessionManager } = codingAgentModule as any;
  const sessionManager = SessionManager.inMemory(cwd);
  return await withSessionCreationLock(async () => {
    return await createConfiguredAgentSession({
      cwd,
      additionalExtensionPaths: getSubagentExtensionPaths(),
      sessionManager,
    });
  });
}

export async function applySubagentTaskPreferences(
  session: any,
  task: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
  },
) {
  if (task.model) {
    const parts = splitModelRef(task.model);
    const model = parts
      ? session.modelRegistry.find(parts.provider, parts.modelId)
      : undefined;
    if (!model) throw new Error(`Unknown model: ${task.model}`);
    if (!session.modelRegistry.hasConfiguredAuth?.(model)) {
      throw new Error(`No API key for ${task.model}`);
    }
    session.agent.setModel(model);
  }
  if (task.thinkingLevel) {
    const available = session.getAvailableThinkingLevels();
    const level = available.includes(task.thinkingLevel)
      ? task.thinkingLevel
      : available[available.length - 1];
    session.agent.setThinkingLevel(level);
  }
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
          cwd: task.cwd,
        }))
      : [
          {
            prompt: String(params.prompt || ""),
            model:
              normalizeModelRef(params.model) ||
              (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
            thinkingLevel: params.thinkingLevel || currentThinkingLevel,
            cwd: params.cwd,
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

function makePendingResult(
  task: SubagentTask,
  index: number,
  defaultCwd: string,
): TaskResult {
  return {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    cwd: task.cwd || defaultCwd,
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
    makePendingResult(task, index + 1, options.ctx.cwd),
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
        options.ctx.cwd,
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
  defaultCwd: string,
  signal?: AbortSignal,
  onProgress?: (result: TaskResult) => void,
): Promise<TaskResult> {
  const cwd = task.cwd || defaultCwd;
  const messages: Message[] = [];
  const result: TaskResult = {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    cwd,
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
  };

  const { session } = await createIsolatedSession(cwd);
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
    await applySubagentTaskPreferences(session, task);
    await session.prompt(task.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
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
    onProgress?.({ ...result, messages: [...result.messages] });
    return result;
  } finally {
    abortListener?.();
    unsubscribe();
    try {
      await session.abort();
    } catch {}
    try {
      session.dispose?.();
    } catch {}
  }
}
