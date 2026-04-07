import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const format = await import(
  pathToFileURL(path.join(rootDir, "dist", "extensions", "memory", "format.js"))
    .href
);
const onboarding = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "extensions", "memory", "onboarding.js"),
  ).href
);

test("memory format builds compact compiled prompt", () => {
  const text = format.buildCompiledMemoryPrompt({
    memory_prompt_prompt_docs: [
      {
        name: "Core Voice Style",
        memory_prompt_slot: "core_voice_style",
        path: "/tmp/core_voice_style.md",
        content: "简洁",
      },
    ],
    memory_doc_context: "- search note",
  });
  assert.ok(text.includes("# Memory"));
  assert.ok(text.includes("## Memory Prompts"));
  assert.ok(text.includes("## Relevant Memory Docs"));
});

test("memory onboarding helper keeps hidden instructions and pending state", () => {
  const prompt = onboarding.buildOnboardingPrompt("manual");
  assert.ok(prompt.includes("Do not mention, quote, summarize"));
  assert.ok(prompt.includes("preferred language"));
});
