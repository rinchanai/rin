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

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
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

    const prompt = [
      "Capture durable global baselines that should stay present every turn with save_prompts.",
      "If the transcript shows a complex task, a tricky error fix, a non-trivial workflow, or a reusable user-corrected approach, save that procedure as a skill so it can be reused next time.",
      "Agent-generated skills live under the managed self_improve/skills path as ordinary <skill-name>/SKILL.md packages.",
      "When creating or substantially revising such a skill, use the skill-creator skill if it is available.",
      "If an existing skill was missing steps, outdated, incomplete, or wrong, update it immediately.",
      "Do not save transcript summaries, task progress, completed-work logs, or temporary TODO state as self_improve prompts.",
    ].join(" ");
    await session.prompt(prompt, {
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
