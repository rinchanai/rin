import { buildTurnResultFromMessages } from "../session/turn-result.js";
import { markProcessedKoishiMessage, safeString } from "./chat-helpers.js";
import { sendOutboxPayload } from "./transport.js";
import type { KoishiChatState } from "./chat-helpers.js";
import { extractFinalTextFromTurnResult } from "./progress.js";

export function buildAssistantDelivery(
  controller: {
    chatKey: string;
    latestAssistantText?: string;
  },
  input: {
    text?: string;
    replyToMessageId?: string;
    sessionId?: string;
    sessionFile?: string;
  },
) {
  const text = safeString(input.text ?? controller.latestAssistantText).trim();
  if (!text) throw new Error("koishi_final_assistant_text_missing");
  return {
    type: "text_delivery" as const,
    chatKey: controller.chatKey,
    text,
    replyToMessageId:
      safeString(input.replyToMessageId || "").trim() || undefined,
    sessionId: safeString(input.sessionId || "").trim() || undefined,
    sessionFile: safeString(input.sessionFile || "").trim() || undefined,
  };
}

export async function commitPendingDelivery(
  controller: {
    app: any;
    agentDir: string;
    state: KoishiChatState;
    h: any;
    saveState: () => void;
  },
  clearProcessing = false,
) {
  const pending = controller.state.pendingDelivery;
  if (!pending) return;
  await sendOutboxPayload(
    controller.app,
    controller.agentDir,
    {
      ...pending,
      createdAt: new Date().toISOString(),
    },
    controller.h,
  );
  delete controller.state.pendingDelivery;
  if (clearProcessing) delete controller.state.processing;
  controller.saveState();
}

export function markProcessedMessage(
  controller: {
    agentDir: string;
    chatKey: string;
    currentSessionId: () => string;
    currentSessionFile: () => string | undefined;
  },
  messageId?: string,
) {
  const nextMessageId = safeString(messageId || "").trim();
  if (!nextMessageId) return;
  markProcessedKoishiMessage(
    controller.agentDir,
    controller.chatKey,
    nextMessageId,
    {
      sessionId: controller.currentSessionId() || undefined,
      sessionFile: controller.currentSessionFile(),
      processedAt: new Date().toISOString(),
    },
  );
}

export async function refreshSessionMessages(controller: { session: any }) {
  const session: any = controller.session;
  if (!session) return;
  if (typeof session.refreshState === "function") {
    await session.refreshState({ messages: true, session: true });
    return;
  }
  if (typeof session.refreshMessages === "function") {
    await session.refreshMessages();
  }
}

export function collectFinalAssistantText(controller: { session: any }) {
  const messages = Array.isArray(controller.session?.messages)
    ? controller.session.messages
    : [];
  return extractFinalTextFromTurnResult(buildTurnResultFromMessages(messages));
}

export async function completeLiveTurn(controller: {
  liveTurn: { resolve: (value: any) => void } | null;
  latestAssistantText: string;
  currentSessionId: () => string;
  currentSessionFile: () => string | undefined;
}) {
  if (!controller.liveTurn) return;
  const finalText = collectFinalAssistantText(controller as any);
  if (finalText) controller.latestAssistantText = finalText;
  controller.liveTurn.resolve({
    finalText,
    sessionId: controller.currentSessionId() || undefined,
    sessionFile: controller.currentSessionFile(),
  });
}
