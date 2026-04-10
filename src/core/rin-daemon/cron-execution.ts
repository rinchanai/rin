import { spawn } from "node:child_process";
import os from "node:os";

const HOME_DIR = os.homedir();

import { deliverKoishiRpcPayload, requestKoishiRpc } from "../rin-koishi/rpc.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import type { CronTaskRecord } from "./cron.js";

export async function sendKoishiText(
  agentDir: string,
  payload: {
    chatKey: string;
    taskId: string;
    runId: string;
    text: string;
    sessionId?: string;
    sessionFile?: string;
  },
) {
  await deliverKoishiRpcPayload(agentDir, {
    type: "text_delivery",
    createdAt: nowIso(),
    ...payload,
  });
}

export async function resolveCronSessionFile(task: CronTaskRecord) {
  if (task.session.mode === "current") return task.session.sessionFile;
  if (task.session.mode === "dedicated") return task.dedicatedSessionFile;
  throw new Error(
    `cron_invalid_session_mode:${String((task.session as any)?.mode || "unknown")}`,
  );
}

export async function executeCronShellTask(
  task: CronTaskRecord,
  defaultCwd: string,
) {
  if (task.target.kind !== "shell_command")
    throw new Error("cron_invalid_shell_task");
  const { command } = task.target;
  const shell = task.target.shell || process.env.SHELL || "/bin/sh";
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ["-lc", command], {
      cwd: HOME_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const body = [
        `Command: ${command}`,
        `Exit: ${signal ? `signal ${signal}` : (code ?? 0)}`,
        stdout.trim() ? `stdout:\n${summarizeText(stdout, 4000)}` : "",
        stderr.trim() ? `stderr:\n${summarizeText(stderr, 4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (code === 0 && !signal) resolve(body);
      else reject(new Error(body || "cron_command_failed"));
    });
  });
}

export async function executeCronAgentTask(
  task: CronTaskRecord,
  options: {
    cwd: string;
    agentDir: string;
    additionalExtensionPaths?: string[];
  },
) {
  if (task.target.kind !== "agent_prompt")
    throw new Error("cron_invalid_agent_task");
  const sessionFile = await resolveCronSessionFile(task);
  const result = await requestKoishiRpc(options.agentDir, {
    type: "run_chat_turn",
    payload: {
      chatKey: task.chatKey,
      controllerKey: task.id,
      text: task.target.prompt,
      sessionFile,
    },
  });
  const finalText = summarizeText(result?.finalText, 4000);
  if (!finalText) throw new Error("cron_final_assistant_text_missing");
  const nextSessionFile = String(result?.sessionFile || "").trim() || undefined;
  if (task.session.mode === "dedicated" && nextSessionFile) {
    task.dedicatedSessionFile = nextSessionFile;
  }
  return {
    text: finalText,
    sessionId: String(result?.sessionId || "").trim() || undefined,
    sessionFile: nextSessionFile,
    deliveredByChatPipeline: Boolean(task.chatKey),
  };
}

export async function executeCronTask(
  task: CronTaskRecord,
  options: {
    cwd: string;
    agentDir: string;
    additionalExtensionPaths?: string[];
  },
) {
  const runId = cronTaskRunId(task);
  try {
    if (task.target.kind === "shell_command") {
      const text = await executeCronShellTask(task, options.cwd);
      task.lastResultText = text;
      if (task.chatKey && text) {
        await sendKoishiText(options.agentDir, {
          chatKey: task.chatKey,
          taskId: task.id,
          runId,
          text,
        }).catch(() => {});
      }
    } else {
      const result = await executeCronAgentTask(task, options);
      task.lastResultText = result.text;
    }
  } catch (error: any) {
    task.lastError = String(
      error?.message || error || "cron_task_failed",
    ).trim();
  } finally {
    task.running = false;
    task.lastFinishedAt = nowIso();
    task.updatedAt = nowIso();
    if (
      !task.completedAt &&
      task.termination?.maxRuns &&
      task.runCount >= task.termination.maxRuns
    ) {
      task.completedAt = nowIso();
      task.completionReason = "max_runs_reached";
      task.enabled = false;
      task.nextRunAt = undefined;
    }
    if (!task.completedAt && task.termination?.stopAt) {
      const stopTs = Date.parse(task.termination.stopAt);
      if (Number.isFinite(stopTs) && Date.now() >= stopTs) {
        task.completedAt = nowIso();
        task.completionReason = "stop_time_reached";
        task.enabled = false;
        task.nextRunAt = undefined;
      }
    }
  }
}
