import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  applySubagentTaskPreferences,
  executeSubagentRun,
  getSubagentBackendInfo,
} from "../../src/core/subagent/service.js";
import { resolveRuntimeProfile } from "../../src/core/rin-lib/runtime.js";
import type {
  ProviderModelSummary,
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentSessionMode,
  TaskResult,
} from "../../src/core/subagent/types.js";
import {
  buildSubagentAgentText,
  summarizeTaskResult,
} from "./format-utils.js";
import { VALID_SUBAGENT_THINKING_LEVELS as VALID_THINKING_LEVELS } from "./model-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
  getTextOutput,
  replaceTabs,
} from "../../src/core/pi/render-utils.js";

const VALID_SESSION_MODES = ["memory", "persist", "resume", "fork"] as const;

function getDefaultSessionDir() {
  return `${resolveRuntimeProfile().agentDir}/sessions`;
}

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
      "Worker session mode: memory for ephemeral context, persist for a new saved session, resume to continue a saved session, fork to branch from a saved session. Fork sessions persist by default; set session.keep to false to make a fork ephemeral.",
  },
);

const SessionSchema = Type.Optional(
  Type.Object({
    mode: Type.Optional(SessionModeSchema),
    ref: Type.Optional(
      Type.String({
        description:
          `Worker session file path, exact session id, or unique session id prefix. Required for session.mode resume or fork. If you need to discover one, inspect ${getDefaultSessionDir()} with bash/find/rg.`,
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Optional display name for the worker session. Useful for new persisted sessions and renaming resumed or forked sessions.",
      }),
    ),
    keep: Type.Optional(
      Type.Boolean({
        description:
          "When session.mode is `fork`, controls whether the forked worker session is kept for later resume. Defaults to true; set false to use an ephemeral in-memory fork.",
      }),
    ),
  }),
);

const DisabledExtensionsSchema = Type.Optional(
  Type.Array(
    Type.String({
      description:
        "Builtin extension name to hide from the worker, for example `memory`.",
    }),
    {
      description:
        "Optional builtin extension names to hide from the worker runtime.",
    },
  ),
);

const TaskSchema = Type.Object({
  prompt: Type.String({ description: "Prompt for the worker." }),
  model: Type.Optional(
    Type.String({
      description:
        "Exact model id in provider/model form. Use list_models to inspect the currently available models first.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  session: SessionSchema,
  disabledExtensions: DisabledExtensionsSchema,
});

const RunParamsSchema = Type.Object({
  prompt: Type.Optional(
    Type.String({ description: "Prompt for the worker." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact model id in provider/model form. Use list_models to inspect the currently available models first.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  session: SessionSchema,
  disabledExtensions: DisabledExtensionsSchema,
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      description:
        "Parallel worker tasks. All tasks finish before the tool returns.",
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
  truncation?: TruncationResult;
};

type SubagentRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

type SubagentResultRenderState = {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
};

class SubagentResultRenderComponent extends Container {
  state: SubagentResultRenderState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

const SUBAGENT_PREVIEW_LINES = 5;

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function rebuildSubagentResultRenderComponent(
  component: SubagentResultRenderComponent,
  outputText: string,
  fullOutputPath: string | undefined,
  truncated: boolean | undefined,
  expanded: boolean,
  startedAt: number | undefined,
  endedAt: number | undefined,
  theme: any,
): void {
  const state = component.state;
  component.clear();

  const output = String(outputText || "").trim();
  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styledOutput,
              SUBAGENT_PREVIEW_LINES,
              width,
            );
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand" as any, "to expand")})`;
            return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
          }
          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncated) warnings.push("Output truncated");
    component.addChild(
      new Text(`\n${theme.fg("warning", `[${warnings.join('. ')}]`)}`, 0, 0),
    );
  }

  if (startedAt !== undefined) {
    const label = endedAt === undefined ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(
      new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0),
    );
  }
}

function formatModelList(
  details: SubagentDetails | SubagentBackendInfo,
): string {
  const lines: string[] = [];
  lines.push(`backend=${details.backend}`);
  lines.push(`currentModel=${details.currentModel ?? "(not set)"}`);
  lines.push(`currentThinkingLevel=${details.currentThinkingLevel}`);
  lines.push("");
  if (!details.providers.length) {
    lines.push("No available models found. Configure API keys first.");
    return lines.join("\n");
  }
  for (const provider of details.providers) {
    lines.push(
      `${provider.provider}: ${provider.top3.join(", ") || "(none)"}${provider.count > 3 ? ` (+${provider.count - 3} more)` : ""}`,
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

async function writeSubagentFullOutput(agentText: string, userText: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "rin-subagent-"));
  const filePath = path.join(dir, "subagent.txt");
  await writeFile(
    filePath,
    ["## Agent text", agentText, "", "## User text", userText].join("\n"),
    "utf8",
  );
  return filePath;
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
  const text = formatModelList(detailsBase);
  const truncation = truncateHead(text);
  let outputText = truncation.content;
  if (truncation.truncated) {
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
    } else {
      outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
    }
  }
  return {
    content: [{ type: "text" as const, text: outputText }],
    details: {
      ...detailsBase,
      action: "list_models" as const,
      userText: truncation.content,
      truncation: truncation.truncated ? truncation : undefined,
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
      : `\n\nHint: inspect ${getDefaultSessionDir()} with bash/find/rg, then pass session.ref as a session file path, exact id, or unique id prefix.`;
    return {
      content: [{ type: "text" as const, text: `${run.error}${suffix}` }],
      details: detailsBase,
      isError: true,
    };
  }

  const failed = run.results.filter((result) => result.exitCode !== 0);
  const agentText = buildSubagentAgentText(run.results);
  const userText = buildSubagentUserText(run.results);
  const agentTruncation = truncateHead(agentText);
  const userTruncation = truncateHead(userText);
  const truncated = agentTruncation.truncated || userTruncation.truncated;
  const fullOutputPath = truncated
    ? await writeSubagentFullOutput(agentText, userText)
    : undefined;
  const details: SubagentDetails = {
    ...detailsBase,
    results: run.results,
    agentText: agentTruncation.content,
    userText: userTruncation.content,
    fullOutputPath,
    truncated,
  };

  return {
    content: [{ type: "text" as const, text: agentTruncation.content }],
    details,
    isError: failed.length > 0,
  };
}

export { applySubagentTaskPreferences };

export default function subagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_subagent",
    label: "Run Subagent",
    description: "Run a worker with independent context and optional model selection.",
    promptSnippet: "Run a worker with independent context.",
    promptGuidelines: [
      "Use run_subagent to run a worker with independent context and optional model selection.",
      "Always use run_subagent for simple independent work that does not depend on the current conversation context.",
      "Use run_subagent when the user asks for a subagent or wants a different model.",
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
    renderCall(args, theme, context) {
      const state = context.state as SubagentRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        text.setText(
          theme.fg("toolTitle", theme.bold("run_subagent ")) +
            theme.fg("accent", `parallel (${args.tasks.length})`),
        );
        return text;
      }

      const preview = String(args.prompt || "")
        .replace(/\s+/g, " ")
        .trim();
      const previewText = preview ? preview : theme.fg("toolOutput", "...");
      text.setText(
        theme.fg("toolTitle", theme.bold(`run_subagent ${previewText}`)),
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as SubagentRenderState;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const details = result.details as SubagentDetails | undefined;
      const fallback =
        result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)";
      const outputText = String(details?.userText || fallback);
      const component =
        (context.lastComponent as SubagentResultRenderComponent | undefined) ??
        new SubagentResultRenderComponent();
      rebuildSubagentResultRenderComponent(
        component,
        outputText,
        details?.fullOutputPath,
        details?.truncated,
        options.expanded,
        state.startedAt,
        state.endedAt,
        theme,
      );
      component.invalidate();
      return component;
    },
  });

  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description: "List available models.",
    promptSnippet: "List available models.",
    promptGuidelines: [],
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
      return await listModelsResult(ctx, pi.getThinkingLevel());
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("list_models")), 0, 0);
    },
    renderResult(result: any, options, theme, context) {
      const details = result.details as SubagentDetails | undefined;
      const userResult = {
        content: [{ type: "text", text: String(details?.userText || "") }],
        details: {
          truncation: details?.truncation,
        },
      };
      const output = getTextOutput(userResult as any, context.showImages);
      const lines = output.split("\n");
      const maxLines = options.expanded ? lines.length : 10;
      const displayLines = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;
      let text = "";
      if (displayLines.length > 0) {
        text = `\n${displayLines
          .map((line) => theme.fg("toolOutput", replaceTabs(line)))
          .join("\n")}`;
        if (remaining > 0) {
          text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
        }
      }
      const truncation = details?.truncation;
      if (truncation?.truncated) {
        if (truncation.firstLineExceedsLimit) {
          text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
        } else if (truncation.truncatedBy === "lines") {
          text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
        } else {
          text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
