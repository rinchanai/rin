import net from "node:net";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { keyHint } from "../../third_party/pi-coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../../third_party/pi-coding-agent/src/core/tools/truncate.js";
import {
  getTextOutput,
  replaceTabs,
} from "../../third_party/pi-coding-agent/src/core/tools/render-utils.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

function defaultDaemonSocketPath() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return `${runtimeDir}/rin-daemon/daemon.sock`;
  return `${process.env.HOME || ""}/.cache/rin-daemon/daemon.sock`;
}

function parseChatKey(value: unknown) {
  const text = String(value || "").trim();
  return /^[^/:]+(?:\/[^:]+)?:.+$/.test(text) ? text : undefined;
}

async function sendDaemon(command: any) {
  const socketPath = defaultDaemonSocketPath();
  const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {}
      reject(new Error("cron_daemon_timeout"));
    }, 30_000);

    const cleanup = () => clearTimeout(timer);
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload?.type !== "response" || payload?.id !== id) continue;
        cleanup();
        try {
          socket.destroy();
        } catch {}
        if (payload.success !== true)
          reject(new Error(String(payload.error || "cron_request_failed")));
        else resolve(payload.data);
        return;
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  });
}

function createTaskId() {
  return `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function wrapAgentPrompt(prompt: string) {
  return String(prompt || "").trim();
}

function buildTaskForSave(
  input: any,
  defaults: {
    currentSessionFile?: string;
    currentSessionId?: string;
    currentSessionName?: string;
    currentChatKey?: string;
  },
) {
  const taskId = String(input?.id || "").trim() || createTaskId();
  const taskName = String(input?.name || "").trim() || undefined;
  const session = input?.session || { mode: "dedicated" };
  const chatKey =
    input?.chatKey !== undefined ? input.chatKey : defaults.currentChatKey;
  const target =
    input?.target?.kind === "agent_prompt"
      ? {
          kind: "agent_prompt",
          prompt: wrapAgentPrompt(String(input?.target?.prompt || "")),
        }
      : input?.target
        ? {
            kind: "shell_command",
            command: String(input?.target?.command || ""),
            shell: input?.target?.shell,
          }
        : undefined;
  return {
    ...input,
    id: taskId,
    chatKey,
    session,
    target,
  };
}

function summarizeTask(task: any) {
  const target =
    task?.target?.kind === "shell_command"
      ? `command: ${String(task?.target?.command || "")}`
      : `agent: ${String(task?.target?.prompt || "")}`;
  const trigger =
    task?.trigger?.kind === "interval"
      ? `every ${String(task?.trigger?.intervalMs || 0)}ms`
      : task?.trigger?.kind === "cron"
        ? `cron ${String(task?.trigger?.expression || "")}`
        : `once ${String(task?.trigger?.runAt || "")}`;
  return [
    `${String(task?.id || "")}${task?.name ? ` (${String(task.name)})` : ""}`,
    trigger,
    target,
    task?.chatKey ? `chat=${String(task.chatKey)}` : "",
    `session=${String(task?.session?.mode || "")}${task?.session?.sessionFile ? `:${String(task.session.sessionFile)}` : task?.dedicatedSessionFile ? `:${String(task.dedicatedSessionFile)}` : ""}`,
    task?.completedAt
      ? `completed=${String(task.completedAt)}`
      : task?.enabled === false
        ? "disabled"
        : `next=${String(task?.nextRunAt || "pending")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeTaskForAgent(task: any) {
  return summarizeTask(task);
}

function summarizeTaskForUser(task: any) {
  const id = String(task?.id || "").trim();
  const name = String(task?.name || "").trim();
  const trigger =
    task?.trigger?.kind === "interval"
      ? `every ${String(task?.trigger?.intervalMs || 0)}ms`
      : task?.trigger?.kind === "cron"
        ? `cron ${String(task?.trigger?.expression || "")}`
        : `once ${String(task?.trigger?.runAt || "")}`;
  const target =
    task?.target?.kind === "shell_command"
      ? `command: ${String(task?.target?.command || "")}`
      : `agent: ${String(task?.target?.prompt || "")}`;
  const status = task?.completedAt
    ? `completed=${String(task.completedAt)}`
    : task?.enabled === false
      ? "disabled"
      : `next=${String(task?.nextRunAt || "pending")}`;
  return [
    name || id || "unnamed_task",
    id && name ? `id=${id}` : "",
    trigger,
    target,
    status,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTexts(action: string, data: any, params: any) {
  if (action === "list") {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const agentText = tasks.length
      ? tasks.map((task: any) => summarizeTaskForAgent(task)).join("\n\n")
      : "No scheduled tasks.";
    const userText = tasks.length
      ? tasks.map((task: any) => summarizeTaskForUser(task)).join("\n\n")
      : "No scheduled tasks.";
    return { agentText, userText };
  }

  if (action === "get" && data?.task) {
    return {
      agentText: summarizeTaskForAgent(data.task),
      userText: summarizeTaskForUser(data.task),
    };
  }

  const userText = data?.task
    ? summarizeTask(data.task)
    : data?.deleted
      ? `Deleted task: ${String(params?.taskId || "")}`
      : JSON.stringify(data, null, 2);

  const agentText = data?.task
    ? summarizeTaskForAgent(data.task)
    : data?.deleted
      ? `scheduled_task deleted\nid=${String(params?.taskId || "")}`
      : `scheduled_task ${action}`;

  return { agentText, userText };
}

const taskSchema = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Human-friendly task name." }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description: "Whether the task should remain enabled after saving.",
    }),
  ),
  chatKey: Type.Optional(
    Type.Union([
      Type.String({
        description:
          "Explicit bound chat key like telegram/123456:987654321 or onebot/123456:private:12345.",
      }),
      Type.Null(),
    ]),
  ),
  trigger: Type.Object({
    kind: StringEnum(["interval", "cron", "once"] as const, {
      description:
        "Trigger kind. Allowed values: `interval`, `cron`, or `once`.",
    }),
    intervalMs: Type.Optional(
      Type.Number({
        description:
          "For interval tasks. The interval is measured from task start time.",
      }),
    ),
    startAt: Type.Optional(
      Type.String({
        description: "Optional ISO timestamp for the first interval run.",
      }),
    ),
    expression: Type.Optional(
      Type.String({
        description: "Standard 5-field cron expression in local time.",
      }),
    ),
    runAt: Type.Optional(
      Type.String({
        description: "ISO timestamp for a one-time scheduled run.",
      }),
    ),
  }),
  termination: Type.Optional(
    Type.Union([
      Type.Object({
        maxRuns: Type.Optional(
          Type.Number({ description: "Stop after this many runs." }),
        ),
        stopAt: Type.Optional(
          Type.String({
            description: "ISO timestamp after which the task should stop.",
          }),
        ),
      }),
      Type.Null(),
    ]),
  ),
  session: Type.Optional(
    Type.Object({
      mode: StringEnum(["current", "dedicated"] as const, {
        description:
          "Session binding mode. Allowed values: `current` or `dedicated`.",
      }),
      sessionFile: Type.Optional(
        Type.String({
          description:
            "Optional override when mode=current. Ignored for mode=dedicated.",
        }),
      ),
    }),
  ),
  target: Type.Object({
    kind: StringEnum(["agent_prompt", "shell_command"] as const, {
      description:
        "Task target kind. Allowed values: `agent_prompt` or `shell_command`.",
    }),
    prompt: Type.Optional(
      Type.String({
        description: "Instruction for scheduled agent execution.",
      }),
    ),
    command: Type.Optional(
      Type.String({ description: "Shell command for direct execution." }),
    ),
    shell: Type.Optional(
      Type.String({ description: "Optional shell path for shell_command." }),
    ),
  }),
});

const taskIdSchema = Type.Object({
  taskId: Type.String({
    description: "Task id.",
  }),
});

type TaskActionDetails = {
  action: string;
  userText?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  truncation?: TruncationResult;
};

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatListTaskResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
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

  const truncation = result.details?.truncation as TruncationResult | undefined;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }

  return text;
}

async function executeTaskAction(action: string, params: any, ctx: any) {
  const currentSessionFile =
    String(ctx.sessionManager.getSessionFile?.() || "").trim() || undefined;
  const currentSessionId =
    String(ctx.sessionManager.getSessionId?.() || "").trim() || undefined;
  const currentSessionName =
    String(ctx.sessionManager.getSessionName?.() || "").trim() || undefined;
  const currentChatKey = parseChatKey(currentSessionName);

  let data: any;
  if (action === "list") data = await sendDaemon({ type: "cron_list_tasks" });
  else if (action === "get") {
    data = await sendDaemon({ type: "cron_get_task", taskId: params?.taskId });
  } else if (action === "save") {
    const task = buildTaskForSave(params, {
      currentSessionFile,
      currentSessionId,
      currentSessionName,
      currentChatKey,
    });
    data = await sendDaemon({
      type: "cron_upsert_task",
      task,
      defaults: {
        sessionFile: currentSessionFile,
        sessionId: currentSessionId,
        sessionName: currentSessionName,
        chatKey: currentChatKey,
      },
    });
  } else if (action === "delete") {
    data = await sendDaemon({
      type: "cron_delete_task",
      taskId: params?.taskId,
    });
  } else if (action === "pause") {
    data = await sendDaemon({
      type: "cron_pause_task",
      taskId: params?.taskId,
    });
  } else if (action === "resume") {
    data = await sendDaemon({
      type: "cron_resume_task",
      taskId: params?.taskId,
    });
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  const texts = buildTexts(action, data, params);
  if (action === "list" || action === "get") {
    const agentTruncation = truncateHead(texts.agentText);
    const userTruncation = truncateHead(texts.userText);
    let outputText = agentTruncation.content;
    if (agentTruncation.truncated) {
      if (agentTruncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing ${agentTruncation.outputLines} of ${agentTruncation.totalLines} lines.]`;
      } else {
        outputText += `\n\n[Showing ${agentTruncation.outputLines} of ${agentTruncation.totalLines} lines (${formatSize(agentTruncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
      }
    }
    return {
      content: [{ type: "text" as const, text: outputText }],
      details: {
        ...data,
        action,
        userText: userTruncation.content,
        truncation: userTruncation.truncated ? userTruncation : undefined,
      } satisfies TaskActionDetails,
    };
  }

  const prepared = await prepareToolTextOutput({
    ...texts,
    tempPrefix: "rin-scheduled-tasks-",
    filename: "scheduled-tasks.txt",
  });

  return {
    content: [{ type: "text" as const, text: prepared.agentText }],
    details: { ...data, action, ...prepared } satisfies TaskActionDetails,
  };
}

function renderTaskResult(result: any, options: any, theme: any, context: any) {
  const details = result.details as TaskActionDetails | undefined;
  if (details?.action === "list" || details?.action === "get") {
    return new Text(
      formatListTaskResult(result, options, theme, context.showImages),
      0,
      0,
    );
  }
  const fallback =
    result.content?.[0]?.type === "text"
      ? result.content[0].text
      : "(no output)";
  return new Text(String(details?.userText || fallback), 0, 0);
}

export default function cronExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_tasks",
    label: "List Tasks",
    description: "List scheduled tasks.",
    promptSnippet: "List scheduled tasks.",
    promptGuidelines: [],
    parameters: Type.Object({}),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction("list", params, ctx),
    renderResult: renderTaskResult,
  });

  pi.registerTool({
    name: "get_task",
    label: "Get Task",
    description: "Get a specific scheduled task.",
    promptSnippet: "Get a specific scheduled task.",
    promptGuidelines: [],
    parameters: taskIdSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction("get", params, ctx),
    renderResult: renderTaskResult,
  });

  pi.registerTool({
    name: "save_task",
    label: "Save Task",
    description: "Create or update a scheduled task.",
    promptSnippet: "Create or update a scheduled task.",
    promptGuidelines: ["Use save_task to create or update a scheduled task."],
    parameters: taskSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction("save", params, ctx),
    renderResult: renderTaskResult,
  });

  for (const [name, label, action, description, guideline] of [
    [
      "delete_task",
      "Delete Task",
      "delete",
      "Delete a scheduled task.",
      "Use delete_task to delete a scheduled task.",
    ],
    [
      "pause_task",
      "Pause Task",
      "pause",
      "Pause a scheduled task.",
      "Use pause_task to pause a scheduled task.",
    ],
    [
      "resume_task",
      "Resume Task",
      "resume",
      "Resume a scheduled task.",
      "Use resume_task to resume a scheduled task.",
    ],
  ] as const) {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: description,
      promptGuidelines: [guideline],
      parameters: taskIdSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
        await executeTaskAction(action, params, ctx),
      renderResult: renderTaskResult,
    });
  }
}
