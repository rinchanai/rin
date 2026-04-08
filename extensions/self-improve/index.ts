import {
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  enqueueMemoryMaintenanceJob,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import { maintainMemory } from "./maintainer.js";
import {
  buildOnboardingPrompt,
  compileSelfImprovePrompt,
  executeSelfImproveTool,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
  resolveAgentDir,
  loadSelfImproveStore,
} from "./lib.js";
import { refineSelfImprovePromptSlot } from "./processing.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

let installerAutoInitConsumed = false;

const SELF_IMPROVE_SYSTEM_GUIDANCE = [
  "# Self-improve guidance",
  "You have persistent self-improvement state across sessions.",
  "Use save_self_improve_prompt for short always-on baselines that should stay present every turn.",
  "Prioritize durable user preferences, recurring corrections, and stable workflow expectations.",
  "Do not store task progress, transient TODOs, one-off implementation chatter, or noisy session summaries in always-on self-improve prompts.",
  "If knowledge is procedural and reusable, prefer skills. If it must stay present every turn, prefer self-improve prompts.",
].join("\n");

const SELF_IMPROVE_REVIEW_INTERVAL = 8;
const reviewStateBySession = new Map<
  string,
  { userTurns: number; lastQueuedTurn: number }
>();

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
  };
}

function getSessionReviewState(sessionId: string) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const current = reviewStateBySession.get(key) || {
    userTurns: 0,
    lastQueuedTurn: 0,
  };
  reviewStateBySession.set(key, current);
  return current;
}

function triggerInitConversation(
  pi: ExtensionAPI,
  mode: "auto" | "manual",
  busy: boolean,
) {
  pi.sendMessage(
    {
      customType: "self-improve-init-trigger",
      content:
        mode === "auto"
          ? "Begin self-improve onboarding."
          : "Begin requested self-improve onboarding.",
      display: false,
    },
    busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
  );
}

function branchToMessages(entries: any[]): any[] {
  return entries
    .filter((entry) => entry?.type === "message" && entry?.message)
    .map((entry) => entry.message);
}

function loadMessagesFromSessionFile(sessionFile: string): any[] {
  const file = String(sessionFile || "").trim();
  if (!file) return [];
  try {
    return branchToMessages(SessionManager.open(file).getBranch());
  } catch {
    return [];
  }
}

async function processSelfImproveReview(
  ctx: any,
  messages: any[],
  opts: { sessionFile?: string; trigger: string; snapshotKey?: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  const cwd = String(ctx?.cwd || ctx?.sessionManager?.getCwd?.() || "").trim();
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !sessionFile ||
    !agentDir ||
    !cwd
  ) {
    return;
  }
  await enqueueMemoryMaintenanceJob({
    agentDir,
    cwd,
    sessionFile,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
    messages,
  });
  spawnQueuedMemoryWorker(agentDir);
}

const saveSelfImprovePromptParams = Type.Object({
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")],
    {
      description:
        "Self-improve prompt action. Allowed values: `add`, `replace`, or `remove`.",
    },
  ),
  selfImprovePromptSlot: Type.Union(
    [
      Type.Literal("agent_profile"),
      Type.Literal("user_profile"),
      Type.Literal("core_doctrine"),
      Type.Literal("core_facts"),
    ],
    {
      description:
        "Self-improve prompt slot name. Allowed values: `agent_profile`, `user_profile`, `core_doctrine`, `core_facts`.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "New self-improve prompt content. Required for `add` and `replace`.",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description:
        "Short unique substring identifying the text to replace or remove inside the current slot.",
    }),
  ),
  source: Type.Optional(Type.String()),
});

async function executeSaveSelfImprovePromptAction(params: any) {
  try {
    const action = String(params?.action || "add").trim();
    const existing = await executeSelfImproveTool({ action: "compile" });
    const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
      ? existing.self_improve_prompt_prompt_docs.find(
          (doc: any) =>
            String(doc?.self_improve_prompt_slot || "").trim() ===
            String(params.selfImprovePromptSlot || "").trim(),
        )
      : null;
    const refined = await refineSelfImprovePromptSlot({
      selfImprovePromptSlot: params.selfImprovePromptSlot,
      incomingContent: params.content,
      oldText: params.oldText,
      action: action as any,
      existingContent: String(currentDoc?.content || ""),
    });
    const response = refined.removed
      ? await executeSelfImproveTool({
          action: "remove_self_improve_prompt",
          selfImprovePromptSlot: params.selfImprovePromptSlot,
        })
      : await executeSelfImproveTool({
          action: "save_self_improve_prompt",
          selfImprovePromptSlot: params.selfImprovePromptSlot,
          name: refined.name,
          content: refined.content,
          source: params.source,
        });
    const targetPath = String(response?.doc?.path || response?.path || "");
    const userVerb =
      action === "remove"
        ? "Removed self-improve prompt"
        : action === "replace"
          ? "Updated self-improve prompt"
          : "Saved self-improve prompt";
    const agentVerb =
      action === "remove"
        ? "self_improve remove_self_improve_prompt"
        : "self_improve save_self_improve_prompt";
    const prepared = await prepareToolTextOutput({
      agentText: `${agentVerb}\npath=${targetPath}`,
      userText: `${userVerb}: ${String(response?.doc?.name || refined.name || params.selfImprovePromptSlot)}\n${targetPath}`,
      tempPrefix: "rin-self-improve-",
      filename: "self-improve-save-prompt.txt",
    });
    return {
      content: [{ type: "text" as const, text: prepared.agentText }],
      details: { ...response, ...prepared, refined, action },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "self_improve_prompt_action_failed",
    );
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        agentText: message,
        userText: `Self-improve prompt 操作失败：${message}`,
      },
      isError: true,
    };
  }
}

function renderSelfImproveResult(result: any) {
  const details = result.details as any;
  const fallback =
    result.content?.[0]?.type === "text"
      ? result.content[0].text
      : "(no output)";
  return new Text(String(details?.userText || fallback), 0, 0);
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "save_self_improve_prompt",
    label: "Save Self-Improve Prompt",
    description: "Persist short always-on self-improve prompts.",
    promptSnippet: "Persist short always-on self-improve prompts.",
    promptGuidelines: [
      "Use save_self_improve_prompt for short always-on baselines that should stay present every turn.",
      "Save proactively when the user corrects you, reveals a durable preference, shares a stable identity cue, or establishes an expectation about how you should behave.",
      "Do not store task progress, session outcomes, completed-work logs, temporary TODO state, or long detailed guidance in self-improve prompts.",
      "Use action=`add` for new durable cues, `replace` when updating a specific existing phrase via oldText, and `remove` when an always-on cue is no longer valid.",
      "Use `core_facts` for durable facts that should stay present every turn; facts can be larger than profile slots, but still keep them curated.",
      "When the knowledge is procedural, prefer skills instead of prompt memory.",
    ],
    parameters: saveSelfImprovePromptParams,
    execute: async (_toolCallId, params) =>
      await executeSaveSelfImprovePromptAction(params),
    renderResult: renderSelfImproveResult,
  });

  pi.on("message_end", async (event, ctx) => {
    const role = String(event?.message?.role || "").trim();
    const meta = sessionMeta(ctx);
    const state = getSessionReviewState(meta.sessionId);
    if (!state || !meta.sessionFile) return;

    if (role === "user") {
      state.userTurns += 1;
      return;
    }

    if (
      role === "assistant" &&
      state.userTurns > 0 &&
      state.userTurns - state.lastQueuedTurn >= SELF_IMPROVE_REVIEW_INTERVAL
    ) {
      await processSelfImproveReview(ctx, [], {
        sessionFile: meta.sessionFile,
        trigger: "extension:periodic_self_improve_review",
        snapshotKey: `review:${state.userTurns}`,
      });
      state.lastQueuedTurn = state.userTurns;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const preparation = event?.preparation;
    const messages = [
      ...(Array.isArray(preparation?.messagesToSummarize)
        ? preparation.messagesToSummarize
        : []),
      ...(Array.isArray(preparation?.turnPrefixMessages)
        ? preparation.turnPrefixMessages
        : []),
    ];
    const sessionFile = sessionMeta(ctx).sessionFile;
    if (!sessionFile || messages.length === 0) return;
    await maintainMemory(ctx as any, {
      sessionFile,
      trigger: "extension:session_compaction_self_improve_review",
      messages,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const meta = sessionMeta(ctx);
    await processSelfImproveReview(
      ctx,
      branchToMessages(ctx?.sessionManager?.getBranch?.() || []),
      {
        sessionFile: meta.sessionFile,
        trigger: "extension:session_shutdown_self_improve_review",
      },
    );
    if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
  });

  pi.on("session_start", async (event, ctx) => {
    if (event?.reason !== "new") return;
    const previousSessionFile = String(event?.previousSessionFile || "").trim();
    if (!previousSessionFile) return;
    await processSelfImproveReview(
      ctx,
      loadMessagesFromSessionFile(previousSessionFile),
      {
        sessionFile: previousSessionFile,
        trigger: "extension:session_start_new_self_improve_review",
      },
    );
  });

  pi.registerCommand("init", {
    description: "Start or restart self-improve onboarding conversation.",
    handler: async (_args, ctx) => {
      await markOnboardingPrompted(resolveAgentDir, "manual:/init");
      ctx.ui.notify(
        ctx.isIdle()
          ? "Self-improve onboarding started."
          : "Self-improve onboarding queued.",
        "info",
      );
      triggerInitConversation(pi, "manual", !ctx.isIdle());
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (
      !installerAutoInitConsumed &&
      String(process.env.RIN_INSTALL_AUTO_INIT || "").trim() === "1"
    ) {
      await markOnboardingPrompted(resolveAgentDir, "auto:installer");
      installerAutoInitConsumed = true;
      process.env.RIN_INSTALL_AUTO_INIT = "";
    }
    await refreshOnboardingCompletion(resolveAgentDir, loadSelfImproveStore);
    const { systemPrompt } = await compileSelfImprovePrompt();
    const blocks: string[] = [];
    if (
      !String(event.systemPrompt || "").includes(SELF_IMPROVE_SYSTEM_GUIDANCE)
    ) {
      blocks.push(SELF_IMPROVE_SYSTEM_GUIDANCE);
    }
    if (
      systemPrompt &&
      !String(event.systemPrompt || "").includes(systemPrompt)
    ) {
      blocks.push(systemPrompt);
    }
    const onboarding = getOnboardingState(resolveAgentDir);
    if (isOnboardingActive(resolveAgentDir, onboarding)) {
      blocks.push(
        buildOnboardingPrompt(
          String(onboarding.lastTrigger || "").startsWith("auto:")
            ? "auto"
            : "manual",
        ),
      );
    }
    if (!blocks.length) return;
    const current = String(event.systemPrompt || "").trimEnd();
    const block = blocks.join("\n\n").trim();
    const projectContextMarker = "\n\n# Project Context\n\n";
    const idx = current.indexOf(projectContextMarker);
    if (idx >= 0) {
      return {
        systemPrompt:
          `${current.slice(0, idx).trimEnd()}\n\n${block}${current.slice(idx)}`.trimEnd(),
      };
    }
    return {
      systemPrompt: `${current}\n\n${block}`.trimEnd(),
    };
  });
}
