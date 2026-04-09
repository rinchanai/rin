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
  "",
  "- You have persistent self-improvement state across sessions.",
  "- Use save_prompts proactively for durable baselines that should stay present every turn, especially preferences, recurring corrections, environment conventions, and other stable facts that reduce future user steering; keep them compact, write them in English, and do not store task progress, session outcomes, or temporary TODO state there.",
  "- Save reusable procedures, workflows, checklists, and playbooks as skills instead; after a complex task, tricky fix, non-trivial workflow, or reusable user-corrected approach, capture it as a skill under /home/rin/.rin/self_improve/skills, use skill-creator for major creation or revision when available, and update outdated or incomplete skills immediately.",
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
        "Write action: `add` creates a new entry, `replace` updates an existing one, and `remove` deletes one identified by `oldText`.",
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
        "Which always-on prompt slot to update: `agent_profile`, `user_profile`, `core_doctrine`, or `core_facts`.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "New prompt content for `add` or `replace`. Keep it durable, compact, and worth injecting in future turns.",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description:
        "Short unique substring that identifies the existing text to replace or remove. Required for `replace` and `remove`.",
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
        : "self_improve save_prompts";
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
    name: "save_prompts",
    label: "Save Prompts",
    description:
      "Save durable prompt baselines that persist across sessions and stay available every turn. Keep them compact and focused on what will still matter later.",
    promptSnippet: "Save durable prompt baselines.",
    promptGuidelines: [
      "Use save_prompts proactively for durable baselines such as preferences, recurring corrections, environment conventions, and stable facts that reduce future user steering.",
      "Keep prompts compact and focused, do not save task progress or temporary state here, and save reusable procedures as skills instead.",
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
    return {
      systemPrompt: `${current}\n\n${block}`.trimEnd(),
    };
  });
}
