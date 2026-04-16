import os from "node:os";
import path from "node:path";

import type { Model } from "@mariozechner/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../../src/core/rin-lib/loader.js";
import { MEMORY_TASK_THINKING_LEVEL } from "../../src/core/rin-lib/memory-task-config.js";
import { openBoundSession } from "../../src/core/session/factory.js";
import {
  buildSessionRecallSummaryPrompt,
  normalizeSessionSummaryText,
} from "../../src/core/session/summary.js";
import {
  appendTranscriptArchiveEntry,
  loadTranscriptSessionEntries,
} from "../memory/transcripts.js";
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
    "Refine existing prompt slots and skills instead of creating duplicates, and remove stale or overly specific lines when needed.",
    "If an existing skill is missing steps, outdated, incomplete, or wrong, update it.",
    "Do not save summaries, progress, temporary state, or weak session-specific patterns.",
  ];

  return prompt.join(" ");
}

async function createForkedSessionManager(options: {
  sessionFile: string;
  leafId?: string;
}) {
  const sessionFile = path.resolve(safeString(options.sessionFile).trim());
  if (!sessionFile) throw new Error("session_file_required");
  const leafId = safeString(options.leafId).trim() || undefined;
  const { SessionManager } = await loadRinSessionManagerModule();
  const sourceManager = SessionManager.open(sessionFile, path.dirname(sessionFile));
  const cwd = safeString(sourceManager.getCwd?.() || "").trim() || HOME_DIR;
  return {
    cwd,
    sessionManager: SessionManager.forkFrom(sessionFile, cwd, undefined, {
      persist: false,
      leafId,
    }),
  };
}

async function runForkedSessionPrompt(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  prompt: string;
  additionalExtensionPaths?: string[];
}) {
  const fork = await createForkedSessionManager({
    sessionFile: options.sessionFile,
    leafId: options.leafId,
  });
  const { session, runtime } = await openBoundSession({
    cwd: fork.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionManager: fork.sessionManager,
    thinkingLevel: MEMORY_TASK_THINKING_LEVEL,
  });
  try {
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    return safeString(session.getLastAssistantText?.() || "").trim();
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}

function isSessionSummaryEntry(entry: { role?: string; customType?: string }) {
  return (
    safeString(entry.role || "").trim() === "sessionSummary" ||
    safeString(entry.customType || "").trim() === "session_summary"
  );
}

async function storeSessionSummaryInTranscriptArchive(options: {
  agentDir: string;
  sessionFile: string;
  summary: string;
}) {
  const agentDir = path.resolve(safeString(options.agentDir).trim());
  const sessionFile = path.resolve(safeString(options.sessionFile).trim());
  const summary = normalizeSessionSummaryText(options.summary);
  if (!sessionFile || !summary) {
    return { skipped: "empty-summary" };
  }

  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionManager = SessionManager.open(sessionFile, path.dirname(sessionFile));
  const sessionId = safeString(sessionManager.getSessionId?.() || "").trim();
  const existingEntries = await loadTranscriptSessionEntries(
    {
      sessionId: sessionId || undefined,
      sessionFile,
    },
    agentDir,
  ).catch(() => []);
  const currentSummary = normalizeSessionSummaryText(
    [...existingEntries]
      .reverse()
      .find((entry) => isSessionSummaryEntry(entry))?.text || "",
  );
  if (currentSummary && currentSummary === summary) {
    return {
      skipped: "unchanged",
      sessionId: sessionId || undefined,
      sessionSummary: currentSummary,
    };
  }

  await appendTranscriptArchiveEntry(
    {
      timestamp: new Date().toISOString(),
      sessionId,
      sessionFile,
      role: "sessionSummary",
      customType: "session_summary",
      text: summary,
      display: false,
    },
    agentDir,
  );
  return {
    skipped: "",
    sessionId: sessionId || undefined,
    sessionSummary: summary,
  };
}

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const finalText = await runForkedSessionPrompt({
    agentDir: options.agentDir,
    sessionFile: options.sessionFile,
    leafId: options.leafId,
    prompt: buildSelfImproveReviewPrompt(safeString(options.trigger).trim()),
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  return {
    skipped: "",
    forked: true,
    saved: true,
    output: finalText,
  };
}

export async function maintainMemory(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const sessionFile = safeString(opts.sessionFile || "").trim();
  if (!sessionFile) return { skipped: "no-session-file" };
  const extracted = await runForkedSessionSelfImproveReview({
    agentDir: safeString(opts.agentDir || resolveAgentDir()).trim() || resolveAgentDir(),
    sessionFile,
    leafId: safeString(opts.leafId || "").trim() || undefined,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
    additionalExtensionPaths: opts.additionalExtensionPaths,
  });
  return {
    ...extracted,
    mode: "session",
    sessionFile,
    leafId: safeString(opts.leafId || "").trim() || undefined,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
  };
}

export async function maintainSessionSummary(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
  } = {},
) {
  const sessionFile = safeString(opts.sessionFile || "").trim();
  if (!sessionFile) return { skipped: "no-session-file" };
  const agentDir =
    safeString(opts.agentDir || resolveAgentDir()).trim() || resolveAgentDir();
  const output = await runForkedSessionPrompt({
    agentDir,
    sessionFile,
    leafId: safeString(opts.leafId || "").trim() || undefined,
    prompt: buildSessionRecallSummaryPrompt(sessionFile),
  });
  const applied = await storeSessionSummaryInTranscriptArchive({
    agentDir,
    sessionFile,
    summary: output,
  });
  return {
    ...applied,
    mode: "session",
    sessionFile,
    leafId: safeString(opts.leafId || "").trim() || undefined,
    trigger: safeString(opts.trigger || "extension:session_summary").trim(),
    output,
  };
}
