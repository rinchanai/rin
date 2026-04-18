import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const chatRuntimeCommon = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "common.js"))
    .href,
);

test("chat runtime common helpers normalize and render nodes consistently", () => {
  const nodes = chatRuntimeCommon.flattenNodes([
    chatRuntimeCommon.normalizeNode("text", { content: "Hello" }),
    [
      chatRuntimeCommon.normalizeNode("at", { id: "42", name: "Rin" }),
      chatRuntimeCommon.normalizeNode("paragraph", {}, [
        chatRuntimeCommon.normalizeNode("text", { content: " world" }),
      ]),
      null,
    ],
  ]);

  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(nodes),
    "Hello@Rinworld",
  );
  assert.equal(
    chatRuntimeCommon.renderPlainTextFromNodes(nodes, {
      renderAt: (attrs) => `<@${attrs.id}>`,
    }),
    "Hello<@42>world",
  );
  assert.equal(
    chatRuntimeCommon.extractQuoteMessageId([
      chatRuntimeCommon.normalizeNode("quote", { id: "abc123" }),
    ]),
    "abc123",
  );

  const prepared = chatRuntimeCommon.prepareOutboundNodes([
    "Hello",
    chatRuntimeCommon.normalizeNode("quote", { id: "abc123" }),
    [chatRuntimeCommon.normalizeNode("at", { id: "42", name: "Rin" })],
  ]);
  assert.deepEqual(
    prepared.nodes.map((node) => node.type),
    ["text", "quote", "at"],
  );
  assert.deepEqual(
    prepared.work.map((node) => node.type),
    ["text", "at"],
  );
  assert.equal(prepared.replyToMessageId, "abc123");
});

test("chat runtime common helpers preserve binary payload naming for buffers and file urls", async () => {
  const bufferPayload = await chatRuntimeCommon.readBinaryFromNode(
    chatRuntimeCommon.normalizeNode("file", {
      data: Buffer.from("demo"),
      name: 'bad:/\\name?*',
      mimeType: "image/png",
    }),
  );
  assert.equal(bufferPayload?.name, "bad_name_.png");
  assert.equal(bufferPayload?.mimeType, "image/png");
  assert.equal(bufferPayload?.data.toString("utf8"), "demo");

  const tempDir = await fs.mkdtemp(
    path.join(rootDir, ".tmp-rin-chat-runtime-"),
  );
  try {
    const filePath = path.join(tempDir, "note");
    await fs.writeFile(filePath, "hello file\n", "utf8");
    const filePayload = await chatRuntimeCommon.readBinaryFromNode(
      chatRuntimeCommon.normalizeNode("file", {
        src: chatRuntimeCommon.fileUrl(filePath),
        mimeType: "text/plain",
      }),
    );
    assert.equal(filePayload?.name, "note.txt");
    assert.equal(filePayload?.mimeType, "text/plain");
    assert.equal(filePayload?.data.toString("utf8"), "hello file\n");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
