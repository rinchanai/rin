import { spawn } from "node:child_process";

import { enqueueChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import { runSessionPrompt } from "../session/runner.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import type { CronTaskRecord } from "./cron.js";

export async function sendKoishiText(
  agentDir: string,
  payload: { chatKey: string; taskId: string; runId: string; text: string },
) {
  enqueueChatOutboxPayload(agentDir, {
    type: "text_delivery",
    createdAt: nowIso(),
    ...payload,
  });
}

export async function resolveCronSessionFile(task: CronTaskRecord) {
  if (task.session.mode === "specific" || task.session.mode === "current")
    return task.session.sessionFile;
  if (task.dedicatedSessionFile) return task.dedicatedSessionFile;
  return undefined;
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
      cwd: task.cwd || defaultCwd,
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
  const result = await runSessionPrompt({
    cwd: task.cwd || options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    sessionFile: await resolveCronSessionFile(task),
    prompt: task.target.prompt,
  });
  if (task.session.mode === "dedicated" && result.sessionFile)
    task.dedicatedSessionFile = result.sessionFile;
  const finalText = summarizeText(result.finalText, 4000);
  return (
    finalText ||
    `Scheduled agent turn finished in session ${result.sessionFile || "(ephemeral)"}`
  );
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
    const result =
      task.target.kind === "shell_command"
        ? await executeCronShellTask(task, options.cwd)
        : await executeCronAgentTask(task, options);
    task.lastResultText = result;
    if (task.chatKey && result) {
      await sendKoishiText(options.agentDir, {
        chatKey: task.chatKey,
        taskId: task.id,
        runId,
        text: result,
      }).catch(() => {});
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
