import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const format = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "self-improve", "format.js"),
  ).href
);
const onboarding = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "self-improve", "onboarding.js"),
  ).href
);

test("self-improve format builds compact compiled prompt", () => {
  const text = format.buildCompiledSelfImprovePrompt({
    self_improve_prompt_prompt_docs: [
      {
        name: "Agent Profile",
        self_improve_prompt_slot: "agent_profile",
        path: "/tmp/agent_profile.md",
        content: "简洁",
      },
    ],
  });
  assert.ok(text.includes("## Self-Improve Prompts"));
  assert.ok(!text.includes("# Self Improve"));
});

test("memory onboarding helper keeps hidden instructions and pending state", () => {
  const prompt = onboarding.buildOnboardingPrompt("manual");
  assert.ok(prompt.includes("Do not mention, quote, summarize"));
  assert.ok(prompt.includes("preferred language"));
});
