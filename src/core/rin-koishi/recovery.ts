import { buildTurnResultFromMessages } from "../session/turn-result.js";
import { extractTextFromContent, safeString } from "./chat-helpers.js";
import { extractFinalTextFromTurnResult } from "./progress.js";
import { buildPromptText } from "./transport.js";

export async function recoverKoishiTurnIfNeeded(controller: any) {
  await controller.runExclusiveTurn(async () => {
    if (controller.state.pendingDelivery) {
      await controller.commitPendingDelivery(true);
      return;
    }
    if (!controller.state.processing) return;
    await controller.connect();
    if (!controller.session) return;
    await controller.refreshSessionMessages().catch(() => {});
    const messages = Array.isArray(controller.session.messages)
      ? controller.session.messages
      : [];
    const lastUserIndex =
      [...messages]
        .map((message: any, index: number) => ({ message, index }))
        .reverse()
        .find((entry: any) => entry?.message?.role === "user")?.index ?? -1;
    const lastAssistantAfterUser = messages
      .slice(lastUserIndex + 1)
      .reverse()
      .find((message: any) => message?.role === "assistant");
    const deliveredCompletedText = lastAssistantAfterUser
      ? extractFinalTextFromTurnResult(buildTurnResultFromMessages(messages))
      : "";
    const currentLastUser = [...messages]
      .reverse()
      .find((message: any) => message?.role === "user");
    const lastUserText = extractTextFromContent(currentLastUser?.content);
    const pending = controller.state.processing;
    const shouldResumeInternally =
      safeString(lastUserText).trim() ===
      safeString(buildPromptText(pending.text, pending.attachments)).trim();
    controller.logger.info(
      `resume interrupted koishi turn chatKey=${controller.chatKey}`,
    );
    if (deliveredCompletedText && !controller.session.isStreaming) {
      controller.latestAssistantText = deliveredCompletedText;
      controller.state.pendingDelivery = controller.buildAssistantDelivery({
        text: controller.latestAssistantText,
        replyToMessageId:
          safeString(pending.replyToMessageId || "").trim() || undefined,
        sessionId: controller.currentSessionId() || undefined,
        sessionFile: controller.currentSessionFile(),
      });
      controller.saveState();
      await controller.commitPendingDelivery(true);
      return;
    }
    if (shouldResumeInternally) {
      controller.latestAssistantText = "";
      const liveTurn = controller.startLiveTurn();
      try {
        await controller.session.resumeInterruptedTurn({
          source: "koishi-bridge",
        });
      } catch (error: any) {
        controller.failLiveTurn(
          error instanceof Error
            ? error
            : new Error(String(error || "koishi_turn_failed")),
        );
        throw error;
      }
      const completion = await liveTurn.promise;
      controller.latestAssistantText = controller.collectFinalAssistantText();
      if (!safeString(controller.latestAssistantText || "").trim()) {
        throw new Error("final_assistant_text_missing");
      }
      controller.state.piSessionFile =
        safeString(
          completion?.sessionFile ||
            controller.session.sessionManager.getSessionFile?.() ||
            controller.state.piSessionFile ||
            "",
        ).trim() || undefined;
      controller.state.pendingDelivery = controller.buildAssistantDelivery({
        text: controller.latestAssistantText,
        replyToMessageId:
          safeString(pending.replyToMessageId || "").trim() || undefined,
        sessionId:
          safeString(
            completion?.sessionId || controller.currentSessionId() || "",
          ).trim() || undefined,
        sessionFile:
          safeString(
            completion?.sessionFile || controller.currentSessionFile() || "",
          ).trim() || undefined,
      });
      controller.saveState();
      await controller.commitPendingDelivery(true);
      return;
    }
    await controller.runTurnNow(
      {
        text: pending.text,
        attachments: pending.attachments,
        replyToMessageId: pending.replyToMessageId,
      },
      "prompt",
    );
  });
}
