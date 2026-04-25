import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const {
  chatStateSessionFileMigrationMarkerPath,
  runChatStateSessionFileUpgradeMigration,
} = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "state-migration.js"),
  ).href
);

test("chat state migration rewrites previous piSessionFile keys once for chat and detached controller state", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-migration-"),
  );
  const chatStatePath = path.join(
    agentDir,
    "data",
    "chats",
    "telegram",
    "1",
    "2",
    "state.json",
  );
  const detachedStatePath = path.join(
    agentDir,
    "data",
    "cron-turns",
    "cron_demo",
    "state.json",
  );
  const untouchedStatePath = path.join(
    agentDir,
    "data",
    "chats",
    "telegram",
    "1",
    "3",
    "state.json",
  );

  await fs.mkdir(path.dirname(chatStatePath), { recursive: true });
  await fs.mkdir(path.dirname(detachedStatePath), { recursive: true });
  await fs.mkdir(path.dirname(untouchedStatePath), { recursive: true });

  await fs.writeFile(
    chatStatePath,
    JSON.stringify({
      chatKey: "telegram/1:2",
      piSessionFile: "previous-chat.jsonl",
      extra: { keep: true },
    }),
  );
  await fs.writeFile(
    detachedStatePath,
    JSON.stringify({
      chatKey: "cron:test",
      piSessionFile: "previous-detached.jsonl",
      note: "keep me",
    }),
  );
  await fs.writeFile(
    untouchedStatePath,
    JSON.stringify({
      chatKey: "telegram/1:3",
      sessionFile: "already-new.jsonl",
    }),
  );

  const first = runChatStateSessionFileUpgradeMigration(agentDir);
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.skipped, false);
  assert.equal(first.scanned, 3);
  assert.equal(first.migrated, 2);

  assert.deepEqual(JSON.parse(await fs.readFile(chatStatePath, "utf8")), {
    chatKey: "telegram/1:2",
    sessionFile: "previous-chat.jsonl",
    extra: { keep: true },
  });
  assert.deepEqual(JSON.parse(await fs.readFile(detachedStatePath, "utf8")), {
    chatKey: "cron:test",
    sessionFile: "previous-detached.jsonl",
    note: "keep me",
  });
  assert.deepEqual(JSON.parse(await fs.readFile(untouchedStatePath, "utf8")), {
    chatKey: "telegram/1:3",
    sessionFile: "already-new.jsonl",
  });

  const markerPath = chatStateSessionFileMigrationMarkerPath(agentDir);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  assert.equal(marker.id, "chat-state-session-file-v1");
  assert.match(String(marker.appliedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(marker.scanned, 3);
  assert.equal(marker.migrated, 2);

  const second = runChatStateSessionFileUpgradeMigration(agentDir);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.skipped, true);
  assert.equal(second.scanned, 0);
  assert.equal(second.migrated, 0);
});

test("chat state migration does not write a marker when no previous state key exists", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-migration-"),
  );
  const statePath = path.join(
    agentDir,
    "data",
    "chats",
    "telegram",
    "1",
    "2",
    "state.json",
  );
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify({ chatKey: "telegram/1:2", sessionFile: "current.jsonl" }),
  );

  const result = runChatStateSessionFileUpgradeMigration(agentDir);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.skipped, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.migrated, 0);

  await assert.rejects(
    fs.access(chatStateSessionFileMigrationMarkerPath(agentDir)),
  );
});
