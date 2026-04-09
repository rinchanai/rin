import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalAppSystemPrompt } from "./helpers/final-system-prompt.mjs";

test("buildFinalAppSystemPrompt includes app-level before_agent_start prompt layers", async () => {
  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt();

  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.ok(baseSystemPrompt.includes("- search_memory:"));
  assert.ok(baseSystemPrompt.includes("- save_prompts:"));

  assert.ok(
    finalSystemPrompt.includes(
      "- Act as the user's assistant by driving each request to full completion, asking for clarification only when genuinely blocked by missing critical information.",
    ),
  );
  assert.ok(
    finalSystemPrompt.includes(
      "- The current system account is dedicated to you, and you have full control over it.",
    ),
  );
  assert.ok(finalSystemPrompt.includes("# Self-improve guidance"));
  assert.ok(
    finalSystemPrompt.includes(
      "Use save_prompts proactively for durable baselines",
    ),
  );
  assert.ok(finalSystemPrompt.includes("- search_memory:"));
  assert.ok(finalSystemPrompt.includes("- save_prompts:"));
});
