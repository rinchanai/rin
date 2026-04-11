import os from "node:os";

import type { Model } from "@mariozechner/pi-ai";

const HOME_DIR = os.homedir();

import { openBoundSession } from "../../src/core/session/factory.js";
import { resolveAgentDir } from "./lib.js";

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => safeString(part?.text))
    .join("\n")
    .trim();
}

function turnTranscript(messages: any[]): string {
  return messages
    .map((message) => {
      const role =
        safeString(
          message?.role || message?.message?.role || "unknown",
        ).trim() || "unknown";
      const content = stringifyContent(
        message?.content ?? message?.message?.content,
      );
      if (!content) return "";
      return `${role.toUpperCase()}: ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildSelfImproveReviewPrompt(trigger: string): string {
  const prompt = [
    "Review the conversation dialectically and derive only durable conclusions that should still matter across sessions.",
    "Prefer explicit user statements and repeated evidence over one-off impressions; if a pattern is weak, new, or temporary, leave it in the transcript.",
    "Save compact stable baselines with save_prompts. Save reusable workflows, troubleshooting methods, operating playbooks, and non-trivial procedures as skills.",
    "If a transcript shows a complex task, tricky fix, or reusable user-corrected approach, capture that procedure as a skill for future reuse.",
    "Refine existing prompt slots and skills instead of creating duplicate variants. Prefer a few sharp conclusions over a long noisy list.",
    "Do not save transcript summaries, task progress, completed-work logs, temporary TODO state, or ephemeral session context.",
    "Agent-generated skills live under the managed self_improve/skills path as ordinary <skill-name>/SKILL.md packages.",
    "When creating or substantially revising a skill, use the skill-creator skill if it is available.",
    "If an existing skill is missing steps, outdated, incomplete, or wrong, update it immediately.",
  ];

  if (trigger === "extension:periodic_self_improve_review") {
    prompt.push(
      "Periodic review: be conservative and save only high-confidence updates that are already clear mid-session.",
      "Focus on repeated corrections, reiterated preferences, and collaboration patterns that no longer look provisional.",
    );
  }

  if (trigger === "extension:session_compaction_self_improve_review") {
    prompt.push(
      "Pre-compaction review: rescue durable preferences, conclusions, and reusable procedures from context that is about to be compressed away.",
      "Treat the archived transcript as authoritative for the soon-to-be-compacted span, but save conclusions and reusable knowledge rather than summaries.",
    );
  }

  if (trigger === "extension:session_shutdown_self_improve_review") {
    prompt.push(
      "End-of-session review: use the full session arc to consolidate stable conclusions and capture reusable workflows revealed by the completed work.",
      "Prefer merging or sharpening existing baselines when the session clarified an earlier partial understanding.",
    );
  }

  return prompt.join(" ");
}

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
  trigger?: string;
  transcriptMessages?: any[];
  additionalExtensionPaths?: string[];
}) {
  const transcript = Array.isArray(options.transcriptMessages)
    ? turnTranscript(options.transcriptMessages)
    : "";

  const { session } = await openBoundSession({
    cwd: HOME_DIR,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionFile: options.sessionFile,
  });
  try {
    const forkTargets = session.getUserMessagesForForking?.() || [];
    const latest = forkTargets[forkTargets.length - 1];
    if (latest?.entryId) {
      const result = await session.fork(latest.entryId);
      if (result?.cancelled) return { skipped: "fork-cancelled" };
    }

    if (transcript.trim()) {
      await session.sendCustomMessage(
        {
          customType: "self_improve_session_transcript",
          display: false,
          content: [
            {
              type: "text",
              text: [
                "Use the archived transcript below as authoritative context before compaction removes it.",
                transcript,
              ].join("\n\n"),
            },
          ],
        },
        { triggerTurn: false },
      );
    }

    await session.prompt(buildSelfImproveReviewPrompt(safeString(options.trigger).trim()), {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    const finalText = safeString(session.getLastAssistantText?.() || "").trim();
    return {
      skipped: "",
      transcriptUsed: Boolean(transcript.trim()),
      forked: Boolean(latest?.entryId),
      saved: true,
      output: finalText,
    };
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      session.dispose?.();
    } catch {}
  }
}

export async function maintainMemory(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    sessionFile?: string;
    trigger?: string;
    messages?: any[];
    additionalExtensionPaths?: string[];
  } = {},
) {
  const sessionFile = safeString(opts.sessionFile || "").trim();
  if (!sessionFile) return { skipped: "no-session-file" };
  const extracted = await runForkedSessionSelfImproveReview({
    agentDir: resolveAgentDir(),
    sessionFile,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
    transcriptMessages: Array.isArray(opts.messages) ? opts.messages : [],
    additionalExtensionPaths: opts.additionalExtensionPaths,
  });
  return {
    ...extracted,
    mode: "session",
    sessionFile,
    trigger: safeString(opts.trigger || "extension:self_improve_review").trim(),
  };
}
