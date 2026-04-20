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
  collectRuntimeSlashCommands,
  collectSlashCommands,
  getOAuthStateFromStorage,
} = helperModule;

test("catalog helpers normalize and dedupe slash commands", () => {
  const commands = collectSlashCommands({
    includeBuiltin: false,
    commandGroups: [
      {
        source: " extension ",
        commands: [
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
      },
      {
        source: "   ",
        commands: [{ name: "ignored", description: "missing source" }],
      },
    ],
    promptTemplates: [
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ],
    skills: [
      {
        name: "  cleanup  ",
        description: "  Remove stale files.  ",
        sourceInfo: { file: "skill-a" },
      },
      {
        name: "   ",
        description: "ignored",
      },
    ],
  });

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

test("catalog helpers collect runtime slash commands in source order", () => {
  const commands = collectRuntimeSlashCommands({
    builtinModuleCommands: [
      {
        invocationName: "  inspect  ",
        description: "  Inspect chat state.  ",
      },
    ],
  });

  const inspectCommand = commands.find((command) => command.name === "inspect");
  assert.deepEqual(inspectCommand, {
    name: "inspect",
    description: "Inspect chat state.",
    source: "builtin_module",
  });
  assert.equal(commands.some((command) => command.name === "model"), true);
});

test("catalog helpers read oauth state from auth storage", () => {
  const state = getOAuthStateFromStorage({
    list: () => [" gemini ", "missing", "", "gemini"],
    get: (providerId) => {
      const normalized = String(providerId).trim();
      if (normalized === "gemini") return { type: " api_key ", key: "secret" };
      return null;
    },
    getOAuthProviders: () => [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: 1,
      },
      {
        id: " gemini ",
        name: "Duplicate",
        usesCallbackServer: 0,
      },
      {
        id: " ",
        name: "Ignored",
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
