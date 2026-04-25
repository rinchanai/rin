import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Model } from "@mariozechner/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { MEMORY_TASK_THINKING_LEVEL } from "../rin-lib/memory-task-config.js";
import { openBoundSession } from "../session/factory.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import { readSessionMetadata } from "../session/metadata.js";
import {
  normalizeMessageText,
  extractMessageText,
} from "../message-content.js";
import { normalizeSessionValue } from "../session/ref.js";
import {
  buildSessionRecallSummaryPrompt,
  normalizeSessionSummaryText,
} from "../session/summary.js";
import {
  appendTranscriptArchiveEntry,
  getTranscriptArchivePath,
  loadTranscriptSessionEntries,
} from "../memory/transcripts.js";
import { nowIso, safeString } from "./core/utils.js";
import { resolveAgentDir } from "./lib.js";
import { selfImprovePromptsDir, selfImproveSkillsDir } from "./paths.js";

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

type MaintenanceChangedFile = {
  path: string;
  change: "created" | "updated" | "deleted";
};

async function collectManagedFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectManagedFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

async function captureManagedArtifactSnapshot(agentDir: string) {
  const root = path.resolve(agentDir);
  const paths = [
    ...(await collectManagedFiles(selfImprovePromptsDir(root))),
    ...(await collectManagedFiles(selfImproveSkillsDir(root))),
  ].sort();
  const snapshot = new Map<string, string>();
  for (const filePath of paths) {
    const relativePath = path.relative(root, filePath) || filePath;
    const buffer = await fs.readFile(filePath);
    snapshot.set(
      filePath,
      `${relativePath}:${createHash("sha1").update(buffer).digest("hex")}`,
    );
  }
  return snapshot;
}

function diffManagedArtifactSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): MaintenanceChangedFile[] {
  const changed: MaintenanceChangedFile[] = [];
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...allPaths].sort()) {
    const beforeHash = before.get(filePath);
    const afterHash = after.get(filePath);
    if (!beforeHash && afterHash) {
      changed.push({ path: filePath, change: "created" });
      continue;
    }
    if (beforeHash && !afterHash) {
      changed.push({ path: filePath, change: "deleted" });
      continue;
    }
    if (beforeHash !== afterHash) {
      changed.push({ path: filePath, change: "updated" });
    }
  }
  return changed;
}

const MAX_SELF_IMPROVE_REVIEW_CONTEXT_CHARS = 32_000;
const MAX_SELF_IMPROVE_REVIEW_ENTRY_CHARS = 1_800;

function truncateText(value: string, maxChars: number): string {
  const text = safeString(value).trim();
  const limit = Math.max(0, Math.trunc(maxChars));
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 18)).trimEnd()} …[truncated]`;
}

function formatReviewEntry(entry: any): string {
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "compaction") {
    const summary = normalizeMessageText(entry.summary || "");
    return summary
      ? `[compaction summary]\n${truncateText(summary, MAX_SELF_IMPROVE_REVIEW_ENTRY_CHARS)}`
      : "";
  }

  if (entry.type === "custom" && isSessionSummaryEntry(entry)) {
    const summary = normalizeMessageText(
      entry.data?.summary || entry.data?.text || "",
    );
    return summary
      ? `[session summary]\n${truncateText(summary, MAX_SELF_IMPROVE_REVIEW_ENTRY_CHARS)}`
      : "";
  }

  const message = entry.type === "message" ? entry.message : undefined;
  const role = safeString(message?.role || "").trim();
  if (role !== "user" && role !== "assistant" && role !== "custom") return "";

  const text = normalizeMessageText(
    extractMessageText(message?.content ?? message?.text ?? "", {
      includeThinking: false,
      trim: true,
    }),
  );
  if (!text) return "";
  return `[${role}]\n${truncateText(text, MAX_SELF_IMPROVE_REVIEW_ENTRY_CHARS)}`;
}

function boundReviewEntries(entries: string[], maxChars: number): string {
  const header = [
    "Bounded source conversation context follows.",
    "Tool outputs, bash logs, and hidden thinking are intentionally omitted; older material may already be covered by existing prompt slots and skills.",
  ].join("\n");
  const footer = "End bounded source conversation context.";
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  const kept: string[] = [];
  let total = header.length + footer.length + 8;
  for (const entry of [...normalized].reverse()) {
    const nextLen = entry.length + 8;
    if (kept.length > 0 && total + nextLen > maxChars) break;
    kept.push(entry);
    total += nextLen;
  }
  kept.reverse();
  const omitted = normalized.length - kept.length;
  return [
    header,
    omitted > 0
      ? `[${omitted} older entries omitted by bounded review context]`
      : "",
    ...kept,
    footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildSelfImproveReviewContext(entries: any[]): string {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => formatReviewEntry(entry))
    .filter(Boolean);
  return boundReviewEntries(rows, MAX_SELF_IMPROVE_REVIEW_CONTEXT_CHARS);
}

function buildSelfImproveReviewPrompt(
  _trigger: string,
  reviewContext: string,
): string {
  const prompt = [
    "Review the bounded conversation context and derive durable conclusions that should still matter across sessions.",
    "Base the review on the bounded context below; it is already curated for this maintenance turn.",
    "Use save_prompts for prompt baselines and skills for reusable procedures, materials, and knowledge.",
    "Simultaneously consolidate, compress, and improve existing prompt slots and skills instead of only adding new content.",
    "If the bounded context contains no durable learning, say so briefly and make no changes.",
    "",
    reviewContext,
  ];

  return prompt.join("\n").trimEnd();
}

async function createForkedSessionManager(options: {
  sessionFile: string;
  leafId?: string;
}) {
  const session = readSessionMetadata(options);
  const sessionFile = session.sessionFile
    ? path.resolve(session.sessionFile)
    : "";
  if (!sessionFile) throw new Error("session_file_required");
  const leafId = session.leafId || undefined;
  const { SessionManager } = await loadRinSessionManagerModule();
  const sourceManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const cwd = safeString(sourceManager.getCwd?.() || "").trim() || HOME_DIR;
  return {
    cwd,
    sessionManager: forkSessionManagerCompat(
      SessionManager as any,
      sessionFile,
      cwd,
      undefined,
      {
        persist: false,
        leafId,
      },
    ),
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
      source: "builtin:self-improve",
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
  const normalizedAgentDir = normalizeSessionValue(options.agentDir);
  const normalizedSessionFile = normalizeSessionValue(options.sessionFile);
  const agentDir = normalizedAgentDir ? path.resolve(normalizedAgentDir) : "";
  const sessionFile = normalizedSessionFile
    ? path.resolve(normalizedSessionFile)
    : "";
  const summary = normalizeSessionSummaryText(options.summary);
  if (!sessionFile || !summary) {
    return { skipped: "empty-summary" };
  }

  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const sessionInfo = readSessionMetadata(sessionManager);
  const sessionId = sessionInfo.sessionId;
  const existingEntries = await loadTranscriptSessionEntries(
    {
      sessionId: sessionId || undefined,
      sessionFile,
    },
    agentDir,
  ).catch(() => []);
  const currentSummary = normalizeSessionSummaryText(
    [...existingEntries].reverse().find((entry) => isSessionSummaryEntry(entry))
      ?.text || "",
  );
  const timestamp = nowIso();
  const archivePath = getTranscriptArchivePath(
    {
      timestamp,
      sessionId,
      sessionFile,
    },
    agentDir,
  );
  if (currentSummary && currentSummary === summary) {
    return {
      skipped: "unchanged",
      sessionId: sessionId || undefined,
      sessionSummary: currentSummary,
      changedFiles: [] as MaintenanceChangedFile[],
    };
  }

  await appendTranscriptArchiveEntry(
    {
      timestamp,
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
    changedFiles: [
      {
        path: archivePath,
        change: currentSummary ? "updated" : "created",
      },
    ] as MaintenanceChangedFile[],
  };
}

async function runBoundedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const session = readSessionMetadata(options);
  const sessionFile = session.sessionFile
    ? path.resolve(session.sessionFile)
    : "";
  if (!sessionFile) throw new Error("session_file_required");
  const leafId = session.leafId || undefined;
  const { SessionManager } = await loadRinSessionManagerModule();
  const sourceManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const cwd = safeString(sourceManager.getCwd?.() || "").trim() || HOME_DIR;
  const reviewContext = buildSelfImproveReviewContext(
    sourceManager.getBranch(leafId),
  );
  const reviewManager = SessionManager.inMemory(cwd);

  const before = await captureManagedArtifactSnapshot(options.agentDir);
  const { session: reviewSession, runtime } = await openBoundSession({
    cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionManager: reviewManager,
    thinkingLevel: MEMORY_TASK_THINKING_LEVEL,
  });
  let finalText = "";
  try {
    await reviewSession.prompt(
      buildSelfImproveReviewPrompt(
        safeString(options.trigger).trim(),
        reviewContext,
      ),
      {
        expandPromptTemplates: false,
        source: "builtin:self-improve",
      },
    );
    await reviewSession.agent.waitForIdle();
    finalText = safeString(reviewSession.getLastAssistantText?.() || "").trim();
  } finally {
    try {
      await reviewSession.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
  const after = await captureManagedArtifactSnapshot(options.agentDir);
  return {
    skipped: "",
    forked: false,
    bounded: true,
    saved: true,
    output: finalText,
    changedFiles: diffManagedArtifactSnapshots(before, after),
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
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const trigger = safeString(opts.trigger || "self_improve:review").trim();
  const leafId = session.leafId || undefined;
  const extracted = await runBoundedSessionSelfImproveReview({
    agentDir: resolveAgentDir(opts.agentDir),
    sessionFile,
    leafId,
    trigger,
    additionalExtensionPaths: opts.additionalExtensionPaths,
  });
  return {
    ...extracted,
    mode: "session",
    sessionFile,
    leafId,
    trigger,
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
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const agentDir = resolveAgentDir(opts.agentDir);
  const leafId = session.leafId || undefined;
  const trigger = safeString(opts.trigger || "session_summary:review").trim();
  const output = await runForkedSessionPrompt({
    agentDir,
    sessionFile,
    leafId,
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
    leafId,
    trigger,
    output,
  };
}
