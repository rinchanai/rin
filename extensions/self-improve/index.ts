import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  enqueueMemoryMaintenanceJob,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import { createSelfImproveReviewSnapshot } from "./maintainer.js";
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
import {
  describeSelfImprovePromptSlot,
  refineSelfImprovePromptSlot,
} from "./processing.js";

let installerAutoInitConsumed = false;

const SELF_IMPROVE_REVIEW_INTERVAL = 8;
const reviewStateBySession = new Map<
  string,
  { userTurns: number; lastQueuedTurn: number }
>();

function sessionMeta(ctx: any) {
  return {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || "").trim(),
    sessionFile: String(ctx?.sessionManager?.getSessionFile?.() || "").trim(),
    leafId: String(ctx?.sessionManager?.getLeafId?.() || "").trim(),
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

async function processSelfImproveReview(
  ctx: any,
  opts: { sessionFile?: string; leafId?: string; trigger: string; snapshotKey?: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return;
  }
  const snapshotSessionFile =
    (await createSelfImproveReviewSnapshot({
      sessionFile,
      leafId: String(opts.leafId || "").trim(),
    })) || sessionFile;
  await enqueueMemoryMaintenanceJob({
    agentDir,
    sessionFile: snapshotSessionFile,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
  });
  spawnQueuedMemoryWorker(agentDir);
}

const saveSelfImprovePromptParams = Type.Object({
  slot: Type.Union(
    [
      Type.Literal("agent_profile"),
      Type.Literal("user_profile"),
      Type.Literal("core_doctrine"),
      Type.Literal("core_facts"),
    ],
    {
      description:
        "Which always-on prompt slot to inspect or update. `agent_profile` stores the assistant's stable role, tone, and behavior style. `user_profile` stores the user's identity knowledge. `core_doctrine` stores durable methodology, worldview, and values. `core_facts` stores durable external facts, environment facts, user preferences, and operating conventions.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Full revised canonical content for the slot. Use one line per topic. Keep the wording concise and information-dense. Omit this on the first call to read the current slot state.",
    }),
  ),
  baseContent: Type.Optional(
    Type.String({
      description:
        "Current canonical content returned by the read step. Before updating a populated slot, first call save_prompts with only `slot` to read the current canonical content. Then pass that returned content here exactly as `baseContent`. Treat the read result as canonical. Keep `content` in the same normalized shape unless you intentionally want save_prompts to re-normalize it.",
    }),
  ),
});

async function executeSaveSelfImprovePromptAction(params: any) {
  try {
    const slot = String(params?.slot || "").trim();
    const existing = await executeSelfImproveTool({ action: "compile" });
    const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
      ? existing.self_improve_prompt_prompt_docs.find(
          (doc: any) =>
            String(doc?.self_improve_prompt_slot || "").trim() === slot,
        )
      : null;
    const currentState = describeSelfImprovePromptSlot({
      slot,
      existingContent: String(currentDoc?.content || ""),
    });

    const usageLine = `usage=${currentState.currentLines}/${currentState.maxLines} lines`;
    const baseContent = String(params?.baseContent || "").trim();
    const incomingContent = String(params?.content || "").trim();

    if (!incomingContent) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Loaded save_prompts slot: ${currentState.slot}`,
            usageLine,
            String(currentDoc?.path || ""),
            currentState.content || "(empty)",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          ok: true,
          status: "review_required",
          slot: currentState.slot,
          usage: `${currentState.currentLines}/${currentState.maxLines} lines`,
          currentContent: currentState.content,
          path: String(currentDoc?.path || ""),
        },
      };
    }

    if (currentState.content && !baseContent) {
      throw new Error("self_improve_base_content_required");
    }

    if (baseContent !== currentState.content) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Stale save_prompts baseContent for slot: ${currentState.slot}`,
            usageLine,
            String(currentDoc?.path || ""),
            currentState.content || "(empty)",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          ok: false,
          status: "stale_base_content",
          slot: currentState.slot,
          usage: `${currentState.currentLines}/${currentState.maxLines} lines`,
          currentContent: currentState.content,
          path: String(currentDoc?.path || ""),
        },
        isError: true,
      };
    }

    const refined = refineSelfImprovePromptSlot({
      slot: currentState.slot,
      incomingContent,
    });
    const response = await executeSelfImproveTool({
      action: "save_self_improve_prompt",
      selfImprovePromptSlot: currentState.slot,
      name: refined.name,
      content: refined.content,
    });
    return {
      content: [{
        type: "text" as const,
        text: [
          `Updated save_prompts slot: ${currentState.slot}`,
          `usage=${refined.nextLines}/${refined.maxLines} lines`,
          String(response?.doc?.path || ""),
          refined.content || "(empty)",
        ].filter(Boolean).join("\n"),
      }],
      details: {
        ...response,
        ok: true,
        status: "updated",
        slot: currentState.slot,
        usage: `${refined.nextLines}/${refined.maxLines} lines`,
        path: String(response?.doc?.path || ""),
      },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "self_improve_prompt_action_failed",
    );
    const slot = String(params?.slot || "").trim();
    let usage = "0/0";
    try {
      if (slot) {
        const existing = await executeSelfImproveTool({ action: "compile" });
        const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
          ? existing.self_improve_prompt_prompt_docs.find(
              (doc: any) =>
                String(doc?.self_improve_prompt_slot || "").trim() === slot,
            )
          : null;
        const currentState = describeSelfImprovePromptSlot({
          slot,
          existingContent: String(currentDoc?.content || ""),
        });
        usage = `${currentState.currentLines}/${currentState.maxLines} lines`;
      }
    } catch {}
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        usage,
        agentText: slot
          ? `save_prompts failed for slot: ${slot}\nusage=${usage}\n${message}`
          : `save_prompts failed\n${message}`,
        userText: slot
          ? `save_prompts failed for slot: ${slot}\nusage=${usage}\n${message}`
          : `save_prompts failed\n${message}`,
      },
      isError: true,
    };
  }
}

function renderSelfImproveResult(result: any, _options: any, theme: any, context: any) {
  const output = result.content
    ?.filter((c: any) => c?.type === "text")
    .map((c: any) => c?.text || "")
    .join("\n");
  if (!output) return new Text("", 0, 0);
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(`\n${context.isError ? theme.fg("error", output) : theme.fg("toolOutput", output)}`);
  return text;
}

export default function selfImproveExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "save_prompts",
    label: "Save Prompts",
    description:
      "Save durable prompt baselines that persist across sessions and stay available every turn. Keep them compact and focused on what will still matter later.",
    promptSnippet: "Save durable prompt baselines.",
    promptGuidelines: [
      "Use save_prompts proactively for durable baselines such as recurring corrections, environment conventions, stable facts, and other long-lived guidance that should remain active every turn.",
      "Use save_prompts only for compact long-lived prompt content; do not store task progress, session outcomes, or temporary state with save_prompts.",
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
      await processSelfImproveReview(ctx, {
        sessionFile: meta.sessionFile,
        leafId: meta.leafId,
        trigger: "extension:periodic_self_improve_review",
        snapshotKey: `review:${state.userTurns}`,
      });
      state.lastQueuedTurn = state.userTurns;
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const meta = sessionMeta(ctx);
    if (!meta.sessionFile) return;
    await processSelfImproveReview(ctx, {
      sessionFile: meta.sessionFile,
      leafId: meta.leafId,
      trigger: "extension:session_compaction_self_improve_review",
      snapshotKey: `compact:${meta.leafId || meta.sessionFile}`,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const meta = sessionMeta(ctx);
    await processSelfImproveReview(ctx, {
      sessionFile: meta.sessionFile,
      leafId: meta.leafId,
      trigger: "extension:session_shutdown_self_improve_review",
    });
    if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
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
    const promptsBlock = blocks[0] || "";

    const insertBeforeMarker = (
      source: string,
      marker: string,
      blockText: string,
    ) => {
      const text = String(blockText || "").trim();
      if (!text) return source;
      const idx = source.indexOf(marker);
      if (idx < 0) return source;
      return `${source.slice(0, idx).trimEnd()}\n\n${text}\n\n${source.slice(idx)}`.trimEnd();
    };

    const skillsMarker =
      "\n\nAvailable skills provide specialized instructions for specific tasks.\n\n";

    let next = current;
    if (promptsBlock) {
      if (next.includes(skillsMarker)) {
        next = insertBeforeMarker(next, skillsMarker, promptsBlock);
      } else {
        next = `${next}\n\n${promptsBlock}`.trimEnd();
      }
    }
    return {
      systemPrompt: next.trimEnd(),
    };
  });
}
