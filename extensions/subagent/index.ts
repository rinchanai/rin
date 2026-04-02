import path from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { getBuiltinExtensionPaths } from "../../src/app/builtin-extensions.js";
import { loadRinCodingAgent } from "../../src/core/rin-lib/loader.js";
import { createConfiguredAgentSession } from "../../src/core/rin-lib/runtime.js";
import {
  buildSubagentAgentText,
  formatUsage,
  formatTokens,
  getFinalOutput,
  summarizeTaskResult,
  type TaskResult,
  type UsageStats,
} from "./format-utils.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";
import {
  buildModelLookup,
  compareModelIds,
  getProviderSummaries,
  normalizeModelRef,
  splitModelRef,
  type ProviderModelSummary,
  VALID_SUBAGENT_THINKING_LEVELS as VALID_THINKING_LEVELS,
} from "./model-utils.js";

const MAX_PARALLEL_TASKS = 8;

const ThinkingLevelSchema = StringEnum(
  VALID_THINKING_LEVELS as ThinkingLevel[],
  {
    description: "Thinking level: off, minimal, low, medium, high, xhigh.",
  },
);

const TaskSchema = Type.Object({
  prompt: Type.String({ description: "Prompt to send to the subagent." }),
  model: Type.Optional(
    Type.String({
      description:
        "Exact model id in provider/model form, e.g. anthropic/claude-sonnet-4-5.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for this task. Defaults to the current project cwd.",
    }),
  ),
});

const RunParamsSchema = Type.Object({
  prompt: Type.Optional(
    Type.String({ description: "Prompt for single-task mode." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact model id in provider/model form, e.g. openai/gpt-5.4.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for single-task mode. Defaults to the current project cwd.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      description:
        "Parallel subagent tasks. All tasks finish before the tool returns.",
    }),
  ),
});

type RunToolParams = {
  prompt?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
  tasks?: Array<{
    prompt: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
  }>;
};

type SubagentDetails = {
  action: "run" | "list_models";
  backend: "in-process-session";
  currentModel?: string;
  currentThinkingLevel: ThinkingLevel;
  providers: ProviderModelSummary[];
  results?: TaskResult[];
  agentText?: string;
  userText?: string;
  fullOutputPath?: string;
  truncated?: boolean;
};

let sessionCreationQueue: Promise<unknown> = Promise.resolve();

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionCreationQueue.then(fn, fn);
  sessionCreationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function formatModelList(details: SubagentDetails): string {
  const lines: string[] = [];
  lines.push(`Backend: ${details.backend}`);
  lines.push(`Current model: ${details.currentModel ?? "(not set)"}`);
  lines.push(`Current thinking: ${details.currentThinkingLevel}`);
  lines.push("");
  if (!details.providers.length) {
    lines.push("No available models found. Configure API keys first.");
    return lines.join("\n");
  }
  lines.push("Available models by provider (latest 3 each):");
  for (const provider of details.providers) {
    lines.push(
      `- ${provider.provider}: ${provider.top3.join(", ") || "(none)"}${provider.count > 3 ? ` (+${provider.count - 3} more)` : ""}`,
    );
  }
  return lines.join("\n");
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

function buildSubagentUserText(results: TaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0);
  return results.length === 1
    ? results[0].output || results[0].errorMessage || "(no output)"
    : [
        `Parallel subagents finished: ${results.length - failed.length}/${results.length} succeeded`,
        ...results.map((result) => {
          const status = result.exitCode === 0 ? "ok" : "failed";
          const preview = (
            result.output ||
            result.errorMessage ||
            "(no output)"
          )
            .replace(/\s+/g, " ")
            .trim();
          return `${result.index}. [${status}] ${result.model || result.requestedModel || "(default model)"} — ${preview.slice(0, 220)}${preview.length > 220 ? "…" : ""}`;
        }),
      ].join("\n\n");
}

function buildRunUpdate(results: TaskResult[], detailsBase: SubagentDetails) {
  const done = results.filter((result) => result.status === "done").length;
  const failed = results.filter((result) => result.status === "error").length;
  const running = results.filter(
    (result) => result.status === "running",
  ).length;
  const pending = results.filter(
    (result) => result.status === "pending",
  ).length;
  const lines = [
    `Subagents: ${done} done, ${failed} failed, ${running} running, ${pending} pending`,
    "",
    ...results.map(summarizeTaskResult),
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      ...detailsBase,
      action: "run" as const,
      results: results.map((result) => ({ ...result })),
    },
  };
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

async function listModelsResult(ctx: any, currentThinkingLevel: ThinkingLevel) {
  const providers = await getProviderSummaries(ctx);
  const detailsBase: SubagentDetails = {
    action: "list_models",
    backend: "in-process-session",
    currentModel: ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined,
    currentThinkingLevel,
    providers,
  };
  const prepared = await prepareToolTextOutput({
    agentText: [
      `subagent_models providers=${detailsBase.providers.length}`,
      ...detailsBase.providers.map(
        (provider) =>
          `${provider.provider}: ${provider.top3.join(", ")}${provider.count > 3 ? ` (+${provider.count - 3} more)` : ""}`,
      ),
    ].join("\n"),
    userText: formatModelList(detailsBase),
    tempPrefix: "rin-subagent-models-",
    filename: "subagent-models.txt",
  });
  return {
    content: [{ type: "text" as const, text: prepared.agentText }],
    details: { ...detailsBase, ...prepared },
  };
}

async function runSubagentResult(
  params: RunToolParams,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
) {
  const providers = await getProviderSummaries(ctx);
  const detailsBase: SubagentDetails = {
    action: "run",
    backend: "in-process-session",
    currentModel: ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined,
    currentThinkingLevel,
    providers,
  };

  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasSingle = Boolean(String(params.prompt || "").trim());
  if (Number(hasTasks) + Number(hasSingle) !== 1) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Provide exactly one mode: either `prompt` for a single subagent, or `tasks` for parallel subagents.",
        },
      ],
      details: detailsBase,
      isError: true,
    };
  }

  if (hasTasks && (params.tasks?.length || 0) > MAX_PARALLEL_TASKS) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Too many parallel tasks (${params.tasks?.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: detailsBase,
      isError: true,
    };
  }

  const availableModels = buildModelLookup(providers);
  const tasks = hasTasks
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
      ];

  for (const task of tasks) {
    if (!String(task.prompt || "").trim()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Every subagent task needs a non-empty prompt.",
          },
        ],
        details: detailsBase,
        isError: true,
      };
    }
    if (task.model && !availableModels.has(task.model)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown or unavailable model: ${task.model}\n\n${formatModelList(detailsBase)}`,
          },
        ],
        details: detailsBase,
        isError: true,
      };
    }
  }

  const progressResults: TaskResult[] = tasks.map((task, index) => ({
    index: index + 1,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    cwd: task.cwd || ctx.cwd,
    status: "pending" as const,
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
  }));
  onUpdate?.(buildRunUpdate(progressResults, detailsBase));

  const results = await Promise.all(
    tasks.map((task, index) =>
      runTask(task, index + 1, ctx.cwd, signal, (partial) => {
        progressResults[index] = partial;
        onUpdate?.(buildRunUpdate(progressResults, detailsBase));
      }),
    ),
  );
  const failed = results.filter((result) => result.exitCode !== 0);
  const prepared = await prepareToolTextOutput({
    agentText: buildSubagentAgentText(results),
    userText: buildSubagentUserText(results),
    tempPrefix: "rin-subagent-",
    filename: "subagent.txt",
  });
  const details: SubagentDetails = {
    ...detailsBase,
    action: "run",
    results,
    ...prepared,
  };

  return {
    content: [{ type: "text" as const, text: prepared.agentText }],
    details,
    isError: failed.length > 0,
  };
}

async function runTask(
  task: {
    prompt: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
  },
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

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_subagent",
    label: "Run Subagent",
    description: "Run subagents.",
    promptSnippet: "Run subagents.",
    promptGuidelines: [
      "Use `run_subagent` to start a subagent session.",
      "Use `run_subagent` for simple independent tasks that do not depend on the current conversation context.",
      "Use `run_subagent` when the user asks for a subagent or wants a different model.",
      "Use `run_subagent` for parallelizable tasks.",
    ],
    parameters: RunParamsSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      return await runSubagentResult(
        rawParams as RunToolParams,
        signal,
        onUpdate,
        ctx,
        pi.getThinkingLevel(),
      );
    },
    renderCall(args, theme) {
      if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("run_subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length})`);
        for (const task of args.tasks.slice(0, 3)) {
          const model = task.model ? ` [${task.model}]` : "";
          const preview = String(task.prompt || "")
            .replace(/\s+/g, " ")
            .trim();
          text += `
  ${theme.fg("muted", "•")} ${theme.fg("dim", preview.slice(0, 70))}${preview.length > 70 ? "…" : ""}${theme.fg("muted", model)}`;
        }
        if (args.tasks.length > 3)
          text += `
  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      const model = args.model ? ` [${args.model}]` : "";
      const preview = String(args.prompt || "")
        .replace(/\s+/g, " ")
        .trim();
      return new Text(
        theme.fg("toolTitle", theme.bold("run_subagent ")) +
          theme.fg("accent", "run") +
          `
  ${theme.fg("dim", preview.slice(0, 100))}${preview.length > 100 ? "…" : ""}${theme.fg("muted", model)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      if (!details.results) {
        return new Text(String(details.userText || "(no output)"), 0, 0);
      }

      if (!expanded) {
        let text = theme.fg(
          "toolTitle",
          theme.bold(
            details.results.length > 1 ? "parallel " : "run_subagent ",
          ),
        );
        text += theme.fg(
          "accent",
          `${details.results.length} result${details.results.length > 1 ? "s" : ""}`,
        );
        for (const task of details.results) {
          const ok = task.exitCode === 0;
          const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const preview = (task.output || task.errorMessage || "(no output)")
            .replace(/\s+/g, " ")
            .trim();
          text += `

${icon} ${theme.fg("accent", task.model || task.requestedModel || "(default model)")}`;
          text += `
${theme.fg("dim", preview.slice(0, 220))}${preview.length > 220 ? "…" : ""}`;
          const usage = formatUsage(task.usage, undefined);
          if (usage)
            text += `
${theme.fg("muted", usage)}`;
        }
        text += `
${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(
        new Text(
          theme.fg(
            "toolTitle",
            theme.bold(
              details.results.length > 1
                ? "parallel subagents"
                : "run_subagent",
            ),
          ),
          0,
          0,
        ),
      );
      container.addChild(
        new Text(theme.fg("muted", `backend: ${details.backend}`), 0, 0),
      );
      for (const task of details.results) {
        const ok = task.exitCode === 0;
        const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            `${icon} ${theme.fg("accent", task.model || task.requestedModel || "(default model)")}`,
            0,
            0,
          ),
        );
        container.addChild(
          new Text(theme.fg("muted", `cwd: ${task.cwd}`), 0, 0),
        );
        container.addChild(new Text(theme.fg("muted", "prompt:"), 0, 0));
        container.addChild(new Text(theme.fg("dim", task.prompt), 0, 0));
        if (task.errorMessage)
          container.addChild(
            new Text(theme.fg("error", task.errorMessage), 0, 0),
          );
        if (task.output) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(task.output.trim(), 0, 0));
        }
        const usage = formatUsage(task.usage, task.model);
        if (usage) container.addChild(new Text(theme.fg("muted", usage), 0, 0));
      }
      return container;
    },
  });

  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description: "List available models.",
    promptSnippet: "List available models.",
    promptGuidelines: [
      "Use `list_models` to get the currently available LLM models.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
      return await listModelsResult(ctx, pi.getThinkingLevel());
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("list_models")), 0, 0);
    },
    renderResult(result, _state, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }
      return new Text(
        String(details.userText || formatModelList(details)),
        0,
        0,
      );
    },
  });
}
