import { createFinalAssistantTextCollector } from "./final-assistant-text.js";

export async function runAssistantTurnWithFinalText(options: {
  session: {
    subscribe?: (listener: (event: any) => void) => (() => void) | void;
  };
  reset?: () => void;
  start: () => Promise<void>;
  waitForCompletion: () => Promise<void>;
}) {
  const collector = createFinalAssistantTextCollector();
  const rawUnsubscribe = options.session.subscribe?.((event: any) => {
    collector.observeEvent(event);
  });
  const unsubscribe = typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  try {
    options.reset?.();
    collector.reset();
    await options.start();
    await options.waitForCompletion();
    const finalText = collector.getText();
    if (!finalText) throw new Error("final_assistant_text_missing");
    return { finalText };
  } finally {
    try {
      unsubscribe?.();
    } catch {}
  }
}
