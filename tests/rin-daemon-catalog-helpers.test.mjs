import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const helperModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "catalog-helpers.js"),
  ).href,
);

const {
  dedupeSlashCommands,
  getExtensionSlashCommands,
  getOAuthStateFromStorage,
  getPromptSlashCommands,
  getSkillSlashCommands,
} = helperModule;

test("catalog helpers normalize and dedupe slash commands", () => {
  const commands = dedupeSlashCommands([
    ...getExtensionSlashCommands(
      [
        {
          invocationName: "  resume  ",
          description: "  Resume a session.  ",
          sourceInfo: { file: "extension-a" },
        },
        {
          name: "resume",
          description: "duplicate entry should be ignored",
        },
      ],
      "extension",
    ),
    ...getPromptSlashCommands([
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ]),
    ...getSkillSlashCommands([
      {
        name: "  cleanup  ",
        description: "  Remove stale files.  ",
        sourceInfo: { file: "skill-a" },
      },
      {
        name: "   ",
        description: "ignored",
      },
    ]),
  ]);

  assert.deepEqual(commands, [
    {
      name: "resume",
      description: "Resume a session.",
      source: "extension",
      sourceInfo: { file: "extension-a" },
    },
    {
      name: "polish",
      description: "Rewrite the final reply.",
      source: "prompt",
      sourceInfo: { file: "prompt-a" },
    },
    {
      name: "skill:cleanup",
      description: "Remove stale files.",
      source: "skill",
      sourceInfo: { file: "skill-a" },
    },
  ]);
});

test("catalog helpers read oauth state from auth storage", () => {
  const state = getOAuthStateFromStorage({
    list: () => ["gemini", "missing"],
    get: (providerId) =>
      providerId === "gemini" ? { type: "api_key", key: "secret" } : null,
    getOAuthProviders: () => [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: 1,
      },
    ],
  });

  assert.deepEqual(state, {
    credentials: {
      gemini: { type: "api_key" },
      missing: undefined,
    },
    providers: [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: true,
      },
    ],
  });
});
