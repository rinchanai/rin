import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const helpers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "chat-helpers.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-koishi-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("koishi chat helpers detect command text and chat metadata", () => {
  const session = {
    platform: "telegram",
    guildId: "g1",
    userId: "u1",
    channelId: "c1",
    author: { name: "Alice" },
    stripped: { content: "/new hello", appel: true },
    content: "/new hello",
  };
  assert.equal(helpers.pickUserId(session), "u1");
  assert.equal(helpers.pickSenderNickname(session), "Alice");
  assert.equal(helpers.getChatId(session), "c1");
  assert.equal(helpers.getChatType(session), "group");
  assert.equal(helpers.isCommandText("/new hello"), true);
  assert.equal(helpers.commandNameFromText("/new hello"), "new");
});

test("koishi chat helpers persist outbound image parts", async () => {
  await withTempDir(async (dir) => {
    const images = [
      { data: Buffer.from("demo").toString("base64"), mimeType: "image/png" },
    ];
    const out = await helpers.persistImageParts(dir, images, "sample");
    assert.equal(out.length, 1);
    const stat = await fs.stat(out[0].path);
    assert.ok(stat.isFile());
  });
});

test("koishi chat helpers only auto-attach explicit file URLs, not plain paths", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "demo.txt");
    await fs.writeFile(filePath, "demo", "utf8");

    assert.deepEqual(
      helpers.extractExistingFilePaths(`Path for reference only: ${filePath}`),
      [],
    );
    assert.deepEqual(
      helpers.extractExistingFilePaths(
        `Explicit attachment: file://${filePath}`,
      ),
      [filePath],
    );
  });
});
