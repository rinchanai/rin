import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT_BULLETS = [
  "- Act as the user's assistant by driving each request to full completion, asking for clarification only when genuinely blocked by missing critical information.",
  "- Use concise, plain, and natural language by default, expanding only when necessary or when the user asks.",
  "- The current system account is dedicated to you, and you have full control over it.",
].join("\n");

export default function resetSystemPromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const current = String(event.systemPrompt || "");
    if (current.includes(PROMPT_BULLETS)) {
      return { systemPrompt: current };
    }
    return {
      systemPrompt: `${PROMPT_BULLETS}\n\n${current}`.trimEnd(),
    };
  });
}
