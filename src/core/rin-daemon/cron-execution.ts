import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import type { ChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import type { CronTaskRecord } from "./cron.js";

type CronChatCapability = {
  send?: (payload: ChatOutboxPayload) => Promise<any>;
  runTurn?: (payload: any) => Promise<any>;
};

export async function sendChatText(
  options: { chat?: CronChatCapability },
  payload: {
    chatKey: string;
    taskId: string;
    runId: string;
    text: string;
    sessionId?: string;
    sessionFile?: string;
  },
) {
  if (typeof options.chat?.send !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  await options.chat.send({
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

function findBashOnPath(): string | null {
  try {
    const result = spawnSync("which", ["bash"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {}
  return null;
}

async function getCronShellConfig(agentDir: string) {
  try {
    const raw = await readFile(path.join(agentDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const customShellPath = String(settings?.shellPath || "").trim();
    if (customShellPath) {
      if (existsSync(customShellPath)) {
        return { shell: customShellPath, args: ["-c"] };
      }
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (existsSync("/bin/bash")) {
    return { shell: "/bin/bash", args: ["-c"] };
  }

  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    return { shell: bashOnPath, args: ["-c"] };
  }

  return { shell: "sh", args: ["-c"] };
}

export async function executeCronShellTask(
  task: CronTaskRecord,
  options: { agentDir: string },
) {
  if (task.target.kind !== "shell_command")
    throw new Error("cron_invalid_shell_task");
  const { command } = task.target;
  const { shell, args } = await getCronShellConfig(options.agentDir);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
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

function cronDetachedControllerStateDir(agentDir: string, controllerKey: string) {
  return path.join(
    agentDir,
    "data",
    "cron-turns",
    String(controllerKey || "").replace(/[^A-Za-z0-9._:-]+/g, "_"),
  );
}

function cleanupCronEphemeralArtifacts(
  agentDir: string,
  controllerKey: string,
  sessionFile?: string,
) {
  if (sessionFile) {
    try {
      rmSync(sessionFile, { force: true });
    } catch {}
  }
  try {
    rmSync(cronDetachedControllerStateDir(agentDir, controllerKey), {
      recursive: true,
      force: true,
    });
  } catch {}
}

export async function executeCronAgentTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
    runId?: string;
  },
) {
  if (task.target.kind !== "agent_prompt")
    throw new Error("cron_invalid_agent_task");
  if (typeof options.chat?.runTurn !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  const seededDedicatedSessionFile =
    task.session.mode === "dedicated"
      ? String(task.dedicatedSessionFile || "").trim() || undefined
      : undefined;
  const ephemeralDedicated =
    task.session.mode === "dedicated" && !seededDedicatedSessionFile;
  const controllerKey =
    ephemeralDedicated && options.runId
      ? `${task.id}:${options.runId}`
      : task.id;
  const sessionFile = ephemeralDedicated
    ? undefined
    : await resolveCronSessionFile(task);
  const result = await options.chat.runTurn({
    chatKey: task.chatKey,
    controllerKey,
    deliveryEnabled: false,
    affectChatBinding: false,
    disposeAfterTurn: ephemeralDedicated,
    text: task.target.prompt,
    sessionFile,
  });
  const finalText = summarizeText(result?.finalText, 4000);
  if (!finalText) throw new Error("cron_final_assistant_text_missing");
  const nextSessionFile = String(result?.sessionFile || "").trim() || undefined;
  if (task.session.mode === "dedicated") {
    if (seededDedicatedSessionFile && nextSessionFile) {
      task.dedicatedSessionFile = nextSessionFile;
    } else {
      task.dedicatedSessionFile = undefined;
    }
  }
  if (ephemeralDedicated) {
    cleanupCronEphemeralArtifacts(options.agentDir, controllerKey, nextSessionFile);
  }
  return {
    text: finalText,
    sessionId: String(result?.sessionId || "").trim() || undefined,
    sessionFile: ephemeralDedicated ? undefined : nextSessionFile,
  };
}

export async function executeCronTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
  },
) {
  const runId = cronTaskRunId(task);
  try {
    if (task.target.kind === "shell_command") {
      const text = await executeCronShellTask(task, {
        agentDir: options.agentDir,
      });
      task.lastResultText = text;
      if (task.chatKey && text) {
        await sendChatText(options, {
          chatKey: task.chatKey,
          taskId: task.id,
          runId,
          text,
        }).catch(() => {});
      }
    } else {
      const result = await executeCronAgentTask(task, { ...options, runId });
      task.lastResultText = result.text;
      if (task.chatKey && result.text) {
        await sendChatText(options, {
          chatKey: task.chatKey,
          taskId: task.id,
          runId,
          text: result.text,
          sessionId: result.sessionId,
          sessionFile: result.sessionFile,
        }).catch(() => {});
      }
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
