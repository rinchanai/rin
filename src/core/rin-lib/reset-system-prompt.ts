import type { BuiltinModuleApi } from "../builtins/host.js";

const PROMPT_PREFIX = "As the assistant, you must fulfill the user's requests.";

export default function resetSystemPromptModule(pi: BuiltinModuleApi) {
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
