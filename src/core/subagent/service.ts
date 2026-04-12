import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import {
  buildModelLookup,
  getProviderSummaries,
  normalizeModelRef,
} from "./models.js";
import {
  createManagedSession,
  isPersistedMode,
  normalizeSessionConfig,
} from "./session-management.js";
import {
  getFinalOutput,
  makePendingResult,
  syncResultFromSession,
  syncSessionMetadata,
} from "./result-state.js";
import type {
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentTask,
  TaskResult,
} from "./types.js";

export const MAX_PARALLEL_SUBAGENT_TASKS = 8;

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
        }))
      : [
          {
            prompt: String(params.prompt || ""),
            model:
              normalizeModelRef(params.model) ||
              (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
            thinkingLevel: params.thinkingLevel || currentThinkingLevel,
            session: normalizeSessionConfig(params.session),
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
      return `Session ref is required when session.mode is ${sessionConfig.mode}. Inspect ${path.join(os.homedir(), ".rin", "sessions")} and use a session file path, exact id, or unique id prefix.`;
    }
    if (
      (sessionConfig.mode === "memory" || sessionConfig.mode === "persist") &&
      sessionConfig.ref
    ) {
      return `Session ref is only valid with session.mode \`resume\` or \`fork\`.`;
    }
  }
  return undefined;
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
    makePendingResult(task, index + 1),
  );
  options.onProgress?.(
    progressResults.map((item) => ({ ...item })),
    details,
  );

  const results = await Promise.all(
    built.tasks.map((task, index) =>
      runSubagentTask(task, index + 1, HOME_DIR, options.signal, (partial) => {
        progressResults[index] = partial;
        options.onProgress?.(
          progressResults.map((item) => ({
            ...item,
            messages: [...item.messages],
          })),
          details,
        );
      }),
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
    ...makePendingResult(task, index),
    messages,
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
