import {
  type ExtensionAPI,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  getToolResultUserText,
  prepareTruncatedAgentUserText,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { normalizeChatKey } from "../chat/support.js";
import { readSessionMetadata } from "../session/metadata.js";

function defaultTaskDaemonSocketPath() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return `${runtimeDir}/rin-daemon/daemon.sock`;
  return `${process.env.HOME || ""}/.cache/rin-daemon/daemon.sock`;
}

async function sendDaemon(command: any) {
  return await requestDaemonCommand(
    {
      ...command,
      id: `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    },
    {
      socketPath: defaultTaskDaemonSocketPath(),
      timeoutMs: 30_000,
    },
  );
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

const NO_SCHEDULED_TASKS_TEXT = "No scheduled tasks.";
const TASK_MUTATION_COMMANDS = {
  delete: "cron_delete_task",
  pause: "cron_pause_task",
  resume: "cron_resume_task",
} as const;

function renderTask(task: any) {
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

function renderTaskList(tasks: any[]) {
  if (!tasks.length) return NO_SCHEDULED_TASKS_TEXT;
  return tasks.map((task) => renderTask(task)).join("\n\n");
}

function formatTaskLabel(task: any) {
  const id = String(task?.id || "").trim();
  const name = String(task?.name || "").trim();
  return name ? `${id} (${name})` : id || "unnamed_task";
}

function buildTexts(action: string, data: any, params: any) {
  if (action === "get") {
    const text = data?.task
      ? renderTask(data.task)
      : renderTaskList(Array.isArray(data?.tasks) ? data.tasks : []);
    return { agentText: text, userText: text };
  }

  if (action === "save" && data?.task) {
    const text = `Saved task: ${formatTaskLabel(data.task)}`;
    return { agentText: text, userText: text };
  }

  const deletedText = `Deleted task: ${String(params?.taskId || "")}`;
  const userText = data?.task
    ? renderTask(data.task)
    : data?.deleted
      ? deletedText
      : JSON.stringify(data, null, 2);
  const agentText = data?.task
    ? renderTask(data.task)
    : data?.deleted
      ? deletedText
      : `scheduled_task ${action}`;
  return { agentText, userText };
}

const taskSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Existing task id to update in place. Omit to create a new task.",
    }),
  ),
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
          "Explicit bound chat like telegram/123456:987654321 or onebot/123456:private:12345.",
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
            "Optional session path override. When mode=current, bind to that current session. When mode=dedicated, tasks are read-and-burn by default; provide this only to seed or resume a persistent dedicated session explicitly.",
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
  }),
});

const getTaskSchema = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description: "Task id. Omit it to list scheduled tasks instead.",
    }),
  ),
});

const manageTaskSchema = Type.Object({
  action: StringEnum(["delete", "pause", "resume"] as const, {
    description: "Task action. Allowed values: `delete`, `pause`, or `resume`.",
  }),
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

function formatListTaskResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  return renderTextToolResult(result, options, theme, showImages, {
    truncation: result.details?.truncation as TruncationResult | undefined,
  });
}

async function executeTaskAction(action: string, params: any, ctx: any) {
  const session = readSessionMetadata(ctx);
  const currentSessionFile = session.sessionFile || undefined;
  const currentSessionId = session.sessionId || undefined;
  const currentSessionName = session.sessionName || undefined;
  const currentChatKey = normalizeChatKey(currentSessionName);

  let data: any;
  if (action === "get") {
    data = await sendDaemon(
      String(params?.taskId || "").trim()
        ? { type: "cron_get_task", taskId: params?.taskId }
        : { type: "cron_list_tasks" },
    );
  } else if (action === "save") {
    const defaults = {
      sessionFile: currentSessionFile,
      sessionId: currentSessionId,
      sessionName: currentSessionName,
      chatKey: currentChatKey,
    };
    data = await sendDaemon({
      type: "cron_upsert_task",
      task: buildTaskForSave(params, {
        currentSessionFile,
        currentSessionId,
        currentSessionName,
        currentChatKey,
      }),
      defaults,
    });
  } else if (action in TASK_MUTATION_COMMANDS) {
    data = await sendDaemon({
      type: TASK_MUTATION_COMMANDS[action as keyof typeof TASK_MUTATION_COMMANDS],
      taskId: params?.taskId,
    });
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  const texts = buildTexts(action, data, params);
  if (action === "get") {
    const truncated = prepareTruncatedAgentUserText(
      texts.agentText,
      texts.userText,
    );
    return {
      content: [{ type: "text" as const, text: truncated.outputText }],
      details: {
        ...data,
        action,
        userText: truncated.userPreviewText,
        truncation: truncated.userTruncation,
      } satisfies TaskActionDetails,
    };
  }

  return {
    content: [{ type: "text" as const, text: texts.agentText }],
    details: {
      ...data,
      action,
      userText: texts.userText,
    } satisfies TaskActionDetails,
  };
}

function formatGetTaskCall(args: any, theme: any) {
  const taskId = String(args?.taskId || "").trim();
  return [
    theme.fg("toolTitle", theme.bold("get_task")),
    taskId ? ` ${theme.fg("accent", taskId)}` : "",
  ].join("");
}

function formatSaveTaskCall(args: any, theme: any) {
  const name = String(args?.name || "").trim();
  const trigger = String(args?.trigger?.kind || "").trim();
  const target = String(args?.target?.kind || "").trim();
  const parts = [
    theme.fg("toolTitle", theme.bold("save_task")),
    name ? ` ${theme.fg("accent", name)}` : "",
    trigger ? theme.fg("muted", ` ${trigger}`) : "",
    target ? theme.fg("muted", ` ${target}`) : "",
  ];
  return parts.join("");
}

function formatManageTaskCall(args: any, theme: any) {
  const action = String(args?.action || "").trim();
  const taskId = String(args?.taskId || "").trim();
  return [
    theme.fg("toolTitle", theme.bold("manage_task")),
    action ? ` ${theme.fg("muted", action)}` : "",
    taskId ? ` ${theme.fg("accent", taskId)}` : "",
  ].join("");
}

function renderTaskResult(result: any, options: any, theme: any, context: any) {
  const details = result.details as TaskActionDetails | undefined;
  if (details?.action === "get") {
    return new Text(
      formatListTaskResult(result, options, theme, context.showImages),
      0,
      0,
    );
  }
  return new Text(
    getToolResultUserText(result, context.showImages, details?.userText),
    0,
    0,
  );
}

export default function cronExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_task",
    label: "Get Task",
    description: "Get a specific scheduled task, or list scheduled tasks when taskId is omitted.",
    promptSnippet: "Get a specific scheduled task, or list scheduled tasks.",
    promptGuidelines: [],
    parameters: getTaskSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction("get", params, ctx),
    renderCall: (args, theme) => new Text(formatGetTaskCall(args, theme), 0, 0),
    renderResult: renderTaskResult,
  });

  pi.registerTool({
    name: "save_task",
    label: "Save Task",
    description: "Create or update a scheduled task.",
    promptSnippet: "Create or update a scheduled task.",
    promptGuidelines: [
      "When save_task sets the chatKey field, the agent's final message is sent to that chat automatically, so the scheduled prompt should focus only on generating the final output and should not repeat delivery instructions.",
    ],
    parameters: taskSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction("save", params, ctx),
    renderCall: (args, theme) => new Text(formatSaveTaskCall(args, theme), 0, 0),
    renderResult: renderTaskResult,
  });

  pi.registerTool({
    name: "manage_task",
    label: "Manage Task",
    description: "Delete, pause, or resume a scheduled task.",
    promptSnippet: "Delete, pause, or resume a scheduled task.",
    promptGuidelines: [],
    parameters: manageTaskSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      await executeTaskAction(String((params as any)?.action || "").trim(), params, ctx),
    renderCall: (args, theme) => new Text(formatManageTaskCall(args, theme), 0, 0),
    renderResult: renderTaskResult,
  });
}
