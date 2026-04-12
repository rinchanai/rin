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

test("koishi chat helpers extract chat metadata", () => {
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
});

test("koishi chat helpers extract reply ids and quote text from canonical koishi quote", () => {
  const session = {
    quote: {
      messageId: "quoted-42",
      content: "older context",
    },
  };
  assert.equal(helpers.pickReplyToMessageId(session), "quoted-42");
  assert.deepEqual(helpers.summarizeQuote(session), {
    messageId: "quoted-42",
    userId: undefined,
    nickname: undefined,
    content: "older context",
  });
});

test("koishi chat helpers derive incoming text from elements", () => {
  assert.equal(
    helpers.elementsToText([
      { type: "text", attrs: { content: "看一下 /tmp/demo.log" } },
    ]),
    "看一下 /tmp/demo.log",
  );
  assert.equal(
    helpers.elementsToText([
      { type: "at", attrs: { id: "1" } },
      { type: "text", attrs: { content: " 看一下 /tmp/demo.log" } },
    ]),
    "看一下 /tmp/demo.log",
  );
  assert.equal(
    helpers.elementsToText([
      { type: "paragraph", children: [{ type: "text", attrs: { content: "第一行" } }] },
      { type: "br" },
      { type: "text", attrs: { content: "第二行" } },
    ]),
    "第一行\n\n第二行",
  );
  assert.equal(
    helpers.elementsToText([
      { type: "img", attrs: { file: "demo.png" } },
    ]),
    "[image:demo.png]",
  );
});


test("koishi chat helpers synthesize text elements only when upstream omitted elements", () => {
  assert.deepEqual(
    helpers.ensureSessionElements({
      stripped: { content: "看一下 /tmp/demo.log" },
    }),
    [{ type: "text", attrs: { content: "看一下 /tmp/demo.log" } }],
  );
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

test("koishi chat helpers report media elements without downloadable resources", async () => {
  await withTempDir(async (dir) => {
    const result = await helpers.extractInboundAttachments(
      [{ type: "img" }],
      dir,
    );
    assert.deepEqual(result.attachments, []);
    assert.deepEqual(result.failures, [
      {
        type: "img",
        kind: "image",
        reason: "missing_resource",
      },
    ]);
    assert.match(
      helpers.buildInboundAttachmentNotice(result.failures),
      /included media that could not be attached/i,
    );
  });
});

test("koishi chat helpers save inbound media when a standard resource is present", async () => {
  await withTempDir(async (dir) => {
    const src = `data:text/plain;base64,${Buffer.from("demo").toString("base64")}`;
    const result = await helpers.extractInboundAttachments(
      [{ type: "file", attrs: { src, file: "demo.txt" } }],
      dir,
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.attachments.length, 1);
    const stat = await fs.stat(result.attachments[0].path);
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
