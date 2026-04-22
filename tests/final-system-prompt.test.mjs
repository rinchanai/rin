import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { pathToFileURL } from "node:url";

import { buildFinalAppSystemPrompt } from "./helpers/final-system-prompt.mjs";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href,
);

test("createConfiguredAgentSession keeps system prompt empty until first turn", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-lazy-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-lazy-prompt-agent-"),
  );

  const { session } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });

  assert.equal(String(session._baseSystemPrompt || ""), "");
  assert.equal(String(session.agent?.state?.systemPrompt || ""), "");

  const baseSystemPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.equal(String(session._baseSystemPrompt || ""), baseSystemPrompt);
  assert.equal(
    String(session.agent?.state?.systemPrompt || ""),
    baseSystemPrompt,
  );
});

test("buildFinalAppSystemPrompt includes app-level before_agent_start prompt layers", async () => {
  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt();

  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.ok(baseSystemPrompt.includes("- search_memory:"));
  assert.ok(baseSystemPrompt.includes("- save_prompts:"));
  assert.ok(baseSystemPrompt.includes("Guidelines:"));

  assert.ok(
    finalSystemPrompt.includes(
      "As the assistant, you must fulfill the user's requests.",
    ),
  );
  assert.ok(!finalSystemPrompt.includes("# Self-improve guidance"));
  assert.ok(
    finalSystemPrompt.includes(
      "Use save_prompts when a durable baseline about the assistant, the user, durable methods and values, or durable facts and operating conventions should remain available by default in future turns rather than only for session-local progress or one-off task state",
    ),
  );
});

test("buildFinalAppSystemPrompt injects configured language from settings", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-lang-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-lang-prompt-agent-"),
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ language: "zh-CN" }, null, 2),
    "utf8",
  );

  const { baseSystemPrompt, finalSystemPrompt } = await buildFinalAppSystemPrompt({
    cwd,
    agentDir,
  });

  assert.ok(baseSystemPrompt.includes("Configured runtime defaults:"));
  assert.ok(baseSystemPrompt.includes("Preferred language: zh-CN"));
  assert.ok(finalSystemPrompt.includes("Preferred language: zh-CN"));
});

test("buildFinalAppSystemPrompt injects a continuation prompt after automatic compaction", async () => {
  const { session, baseSystemPrompt } = await buildFinalAppSystemPrompt();
  runtimeMod.writeCompactionContinuationMarker(session, {
    reason: "threshold",
    assistantPreview: "Need to continue editing tests.",
  });

  const beforeStart = await session._extensionRunner?.emitBeforeAgentStart(
    "",
    undefined,
    baseSystemPrompt,
  );
  const finalSystemPrompt = String(
    beforeStart?.systemPrompt || baseSystemPrompt,
  );

  assert.ok(
    finalSystemPrompt.includes(
      "Context compacted; treat this as a routine internal checkpoint.",
    ),
  );
  assert.ok(
    finalSystemPrompt.includes(
      "Execute the next concrete step directly without narration",
    ),
  );
  assert.equal(
    finalSystemPrompt.includes(
      "Reserve status updates for when the user asked for one, the task is actually complete, or you are blocked and need input.",
    ),
    false,
  );

  const afterConsume = await session._extensionRunner?.emitBeforeAgentStart(
    "",
    undefined,
    baseSystemPrompt,
  );
  const secondPrompt = String(
    afterConsume?.systemPrompt || baseSystemPrompt,
  );
  assert.equal(
    secondPrompt.includes(
      "Context compacted; treat this as a routine internal checkpoint.",
    ),
    false,
  );
});

test("buildFinalAppSystemPrompt keeps self-improve prompts before skills", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-final-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-final-prompt-agent-"),
  );
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# Project Rules\n\n- Test rule\n",
  );
  fs.mkdirSync(path.join(agentDir, "self_improve", "prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(agentDir, "self_improve", "skills", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "prompts", "user_profile.md"),
    "Test user preference.\n",
  );
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "skills", "test-skill", "SKILL.md"),
    [
      "---",
      "name: test-skill",
      "description: test skill description",
      "---",
      "# Test Skill",
      "",
      "Use this skill for testing.",
      "",
    ].join("\n"),
  );

  const { finalSystemPrompt } = await buildFinalAppSystemPrompt({
    cwd,
    agentDir,
  });

  const projectContextIdx = finalSystemPrompt.indexOf("# Project Context");
  const promptsIdx = finalSystemPrompt.indexOf("User profile:");
  const skillsIdx = finalSystemPrompt.indexOf("<available_skills>");

  assert.notEqual(projectContextIdx, -1);
  assert.notEqual(promptsIdx, -1);
  assert.notEqual(skillsIdx, -1);
  assert.ok(projectContextIdx < promptsIdx);
  assert.ok(promptsIdx < skillsIdx);
  assert.ok(!finalSystemPrompt.includes("# Self-Improve Prompts"));
  assert.ok(finalSystemPrompt.includes("<name>test-skill</name>"));
  assert.ok(
    finalSystemPrompt.includes(
      `<path>${path.join(agentDir, "self_improve", "skills", "test-skill")}</path>`,
    ),
  );
  assert.equal(finalSystemPrompt.includes("SKILL.md</path>"), false);
});
