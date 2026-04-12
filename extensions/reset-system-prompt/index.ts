import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT_PREFIX =
  "As the user's assistant, you must fulfill the user's requests and have full control over the current dedicated system account.";

export default function resetSystemPromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const current = String(event.systemPrompt || "");
    if (current.includes(PROMPT_PREFIX)) {
      return { systemPrompt: current };
    }
    return {
      systemPrompt: `${PROMPT_PREFIX}\n\n${current}`.trimEnd(),
    };
  });
}
