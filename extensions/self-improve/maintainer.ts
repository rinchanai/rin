import os from "node:os";
import path from "node:path";

import type { Model } from "@mariozechner/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../../src/core/rin-lib/loader.js";
import { openBoundSession } from "../../src/core/session/factory.js";
import { MEMORY_TASK_THINKING_LEVEL } from "../../src/core/rin-lib/memory-task-config.js";
import { resolveAgentDir } from "./lib.js";

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function buildSelfImproveReviewPrompt(_trigger: string): string {
  const prompt = [
    "Review the conversation and derive durable conclusions that should still matter across sessions.",
    "Save compact stable baselines with save_prompts.",
    "Save reusable workflows, operating playbooks, complex task procedures, troubleshooting methods, and similar durable methods as self improve skills.",
    "Refine existing prompt slots and skills instead of creating duplicates.",
    "If an existing skill is missing steps, outdated, incomplete, or wrong, update it.",
    "Do not save summaries, progress, temporary state, or weak session-specific patterns.",
  ];

  return prompt.join(" ");
}

export async function createSelfImproveReviewSnapshot(options: {
  sessionFile: string;
  leafId?: string;
}) {
  const sessionFile = path.resolve(safeString(options.sessionFile).trim());
  if (!sessionFile) return "";
  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionDir = path.dirname(sessionFile);
  const sourceManager = SessionManager.open(sessionFile, sessionDir);
  const leafId =
    safeString(options.leafId || "").trim() ||
    safeString(sourceManager.getLeafId?.() || "").trim();
  if (!leafId) return "";
  return safeString(sourceManager.createBranchedSession(leafId) || "").trim();
}

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const { session, runtime } = await openBoundSession({
    cwd: HOME_DIR,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionFile: options.sessionFile,
    thinkingLevel: MEMORY_TASK_THINKING_LEVEL,
  });
  try {
    const forkTargets = session.getUserMessagesForForking?.() || [];
    const latest = forkTargets[forkTargets.length - 1];
    if (latest?.entryId) {
      const result = await runtime.fork(latest.entryId);
      if (result?.cancelled) return { skipped: "fork-cancelled" };
    }

    await session.prompt(buildSelfImproveReviewPrompt(safeString(options.trigger).trim()), {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    const finalText = safeString(session.getLastAssistantText?.() || "").trim();
    return {
      skipped: "",
      forked: Boolean(latest?.entryId),
      saved: true,
      output: finalText,
    };
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}

export async function maintainMemory(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    sessionFile?: string;
    trigger?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const sessionFile = safeString(opts.sessionFile || "").trim();
  if (!sessionFile) return { skipped: "no-session-file" };
  const extracted = await runForkedSessionSelfImproveReview({
    agentDir: resolveAgentDir(),
    sessionFile,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
    additionalExtensionPaths: opts.additionalExtensionPaths,
  });
  return {
    ...extracted,
    mode: "session",
    sessionFile,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
  };
}
