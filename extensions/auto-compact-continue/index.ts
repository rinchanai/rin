import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  consumeCompactionContinuationMarker,
  clearCompactionContinuationMarker,
} from "../../src/core/rin-lib/compaction-continuation.js";

const CONTINUATION_BLOCK = [
  "Context compacted; treat this as a routine internal checkpoint.",
  "Resume the current task immediately from its current state.",
  "Execute the next concrete step directly without narration.",
  "If work remains, keep doing it.",
].join("\n");

export default function autoCompactContinueExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    clearCompactionContinuationMarker(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const marker = consumeCompactionContinuationMarker(ctx);
    if (!marker) return;
    const systemPrompt = String(event?.systemPrompt || "").trim();
    return {
      systemPrompt: systemPrompt
        ? `${systemPrompt}\n\n${CONTINUATION_BLOCK}`
        : CONTINUATION_BLOCK,
    };
  });
}
