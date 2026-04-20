import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT_PREFIX =
  "You are Rin, a terminal-first local AI assistant.";

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
