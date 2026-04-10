import { StringEnum } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  applySubagentTaskPreferences,
  executeSubagentRun,
  getSubagentBackendInfo,
} from "../../src/core/subagent/service.js";
import type {
  ProviderModelSummary,
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentSessionMode,
  TaskResult,
} from "../../src/core/subagent/types.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";
import {
  buildSubagentAgentText,
  formatUsage,
  summarizeTaskResult,
} from "./format-utils.js";
import { VALID_SUBAGENT_THINKING_LEVELS as VALID_THINKING_LEVELS } from "./model-utils.js";

const VALID_SESSION_MODES = ["memory", "persist", "resume", "fork"] as const;
const DEFAULT_SESSION_DIR = "~/.rin/sessions";

const ThinkingLevelSchema = StringEnum(
  VALID_THINKING_LEVELS as ThinkingLevel[],
  {
    description: "Thinking level: off, minimal, low, medium, high, xhigh.",
  },
);

const SessionModeSchema = StringEnum(
  [...VALID_SESSION_MODES] as SubagentSessionMode[],
  {
    description:
      "Session mode: memory for ephemeral context, persist for a new saved session, resume to continue a saved session, fork to branch from a saved session.",
  },
);

const SessionSchema = Type.Optional(
  Type.Object({
    mode: Type.Optional(SessionModeSchema),
    ref: Type.Optional(
      Type.String({
        description:
          "Saved session file path, exact session id, or unique session id prefix. Required for session.mode resume or fork. If you need to discover one, inspect ~/.rin/sessions with bash/find/rg.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Optional session display name for the saved session. Useful for new persisted sessions and renaming resumed or forked sessions.",
      }),
    ),
  }),
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
  session: SessionSchema,
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
  session: SessionSchema,
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      description:
        "Parallel subagent tasks. All tasks finish before the tool returns.",
    }),
  ),
});

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

function formatModelList(
  details: SubagentDetails | SubagentBackendInfo,
): string {
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

function buildTaskSessionLabel(result: TaskResult): string | undefined {
  if (!result.sessionPersisted) return undefined;
  return result.sessionName || result.sessionId || result.sessionFile;
}

function buildSubagentUserText(results: TaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (results.length === 1) {
    const single = results[0];
    const base = single.output || single.errorMessage || "(no output)";
    const sessionLabel = buildTaskSessionLabel(single);
    if (!sessionLabel) return base;
    return [
      base,
      "",
      `Session: ${sessionLabel}`,
      single.sessionFile ? `Path: ${single.sessionFile}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
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
      const sessionLabel = buildTaskSessionLabel(result);
      const suffix = sessionLabel ? ` [session: ${sessionLabel}]` : "";
      return `${result.index}. [${status}] ${result.model || result.requestedModel || "(default model)"}${suffix} — ${preview.slice(0, 220)}${preview.length > 220 ? "…" : ""}`;
    }),
  ].join("\n\n");
}

function buildRunUpdate(
  results: TaskResult[],
  detailsBase: SubagentBackendInfo,
) {
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

async function listModelsResult(ctx: any, currentThinkingLevel: ThinkingLevel) {
  const detailsBase = await getSubagentBackendInfo(ctx, currentThinkingLevel);
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
    details: {
      ...detailsBase,
      action: "list_models" as const,
      ...prepared,
    },
  };
}

async function runSubagentResult(
  params: RunSubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
) {
  const run = await executeSubagentRun({
    params,
    signal,
    ctx,
    currentThinkingLevel,
    onProgress(results, details) {
      onUpdate?.(buildRunUpdate(results, details));
    },
  });

  const detailsBase: SubagentDetails = {
    action: "run",
    backend: run.backend,
    currentModel: run.currentModel,
    currentThinkingLevel: run.currentThinkingLevel,
    providers: run.providers,
  };

  if (run.ok === false) {
    const suffix = run.error.startsWith("Unknown or unavailable model:")
      ? `\n\n${formatModelList(detailsBase)}`
      : `\n\nHint: inspect ${DEFAULT_SESSION_DIR} with bash/find/rg, then pass session.ref as a session file path, exact id, or unique id prefix.`;
    return {
      content: [{ type: "text" as const, text: `${run.error}${suffix}` }],
      details: detailsBase,
      isError: true,
    };
  }

  const failed = run.results.filter((result) => result.exitCode !== 0);
  const prepared = await prepareToolTextOutput({
    agentText: buildSubagentAgentText(run.results),
    userText: buildSubagentUserText(run.results),
    tempPrefix: "rin-subagent-",
    filename: "subagent.txt",
  });
  const details: SubagentDetails = {
    ...detailsBase,
    results: run.results,
    ...prepared,
  };

  return {
    content: [{ type: "text" as const, text: prepared.agentText }],
    details,
    isError: failed.length > 0,
  };
}

export { applySubagentTaskPreferences };

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_subagent",
    label: "Run Subagent",
    description: "Run subagents.",
    promptSnippet: "Run subagents.",
    promptGuidelines: [
      "Use run_subagent to start a subagent session.",
      "Default subagent runs use an isolated in-memory session and do not persist.",
      "If the delegated work will span multiple turns or needs existing context, set session.mode to persist, resume, or fork.",
      "When you need an existing session, inspect ~/.rin/sessions with bash/find/rg and pass session.ref as a session file path, exact id, or unique id prefix.",
      "Use run_subagent for simple independent tasks that do not depend on the current conversation context.",
      "Use run_subagent when the user asks for a subagent or wants a different model.",
      "Use run_subagent for parallelizable tasks.",
    ],
    parameters: RunParamsSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      return await runSubagentResult(
        rawParams as RunSubagentParams,
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
          const mode = task.session?.mode ? ` {${task.session.mode}}` : "";
          const preview = String(task.prompt || "")
            .replace(/\s+/g, " ")
            .trim();
          text += `
  ${theme.fg("muted", "•")} ${theme.fg("dim", preview.slice(0, 70))}${preview.length > 70 ? "…" : ""}${theme.fg("muted", `${model}${mode}`)}`;
        }
        if (args.tasks.length > 3)
          text += `
  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      const model = args.model ? ` [${args.model}]` : "";
      const mode = args.session?.mode ? ` {${args.session.mode}}` : "";
      const preview = String(args.prompt || "")
        .replace(/\s+/g, " ")
        .trim();
      return new Text(
        theme.fg("toolTitle", theme.bold("run_subagent ")) +
          theme.fg("accent", "run") +
          `
  ${theme.fg("dim", preview.slice(0, 100))}${preview.length > 100 ? "…" : ""}${theme.fg("muted", `${model}${mode}`)}`,
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
          const sessionLabel = buildTaskSessionLabel(task);
          text += `

${icon} ${theme.fg("accent", task.model || task.requestedModel || "(default model)")}`;
          if (sessionLabel) {
            text += ` ${theme.fg("muted", `[${sessionLabel}]`)}`;
          }
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
          new Text(theme.fg("muted", `session mode: ${task.sessionMode}`), 0, 0),
        );
        if (task.sessionId) {
          container.addChild(
            new Text(theme.fg("muted", `session id: ${task.sessionId}`), 0, 0),
          );
        }
        if (task.sessionName) {
          container.addChild(
            new Text(theme.fg("muted", `session name: ${task.sessionName}`), 0, 0),
          );
        }
        if (task.sessionFile) {
          container.addChild(
            new Text(theme.fg("muted", `session file: ${task.sessionFile}`), 0, 0),
          );
        }
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
      "Use list_models to get the currently available LLM models.",
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
