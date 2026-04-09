import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalAppSystemPrompt } from "./helpers/final-system-prompt.mjs";

test("buildFinalAppSystemPrompt includes app-level before_agent_start prompt layers", async () => {
  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt();

  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.ok(baseSystemPrompt.includes("- search_memory:"));
  assert.ok(baseSystemPrompt.includes("- save_prompts:"));
  assert.ok(baseSystemPrompt.includes("Guidelines:"));

  assert.ok(
    finalSystemPrompt.includes(
      "As the user's assistant, you have full control over the current dedicated system account to fulfill their requests.",
    ),
  );
  assert.ok(finalSystemPrompt.includes("# Self-improve guidance"));
  assert.ok(
    finalSystemPrompt.includes(
      "- Use save_prompts proactively for durable baselines",
    ),
  );
});

test("buildFinalAppSystemPrompt keeps self-improve prompts before skills", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-final-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-final-prompt-agent-"),
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

  const selfImproveGuidanceIdx = finalSystemPrompt.indexOf(
    "# Self-improve guidance",
  );
  const projectContextIdx = finalSystemPrompt.indexOf("# Project Context");
  const promptsIdx = finalSystemPrompt.indexOf("# Self-Improve Prompts");
  const skillsIdx = finalSystemPrompt.indexOf("<available_skills>");

  assert.notEqual(selfImproveGuidanceIdx, -1);
  assert.notEqual(projectContextIdx, -1);
  assert.notEqual(promptsIdx, -1);
  assert.notEqual(skillsIdx, -1);
  assert.ok(selfImproveGuidanceIdx < projectContextIdx);
  assert.ok(projectContextIdx < promptsIdx);
  assert.ok(promptsIdx < skillsIdx);
  assert.ok(finalSystemPrompt.includes("## User Profile"));
});
