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
const transport = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "transport.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-transport-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("koishi transport buildPromptText appends file attachments only", () => {
  const result = transport.buildPromptText("hello", [
    { kind: "file", path: "/tmp/a.txt", name: "a.txt" },
    { kind: "image", path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.ok(result.includes("Attached files saved locally"));
  assert.ok(result.includes("a.txt: /tmp/a.txt"));
  assert.ok(!result.includes("b.png: /tmp/b.png"));
});

test("koishi transport restorePromptParts rebuilds image payloads from disk", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const restored = await transport.restorePromptParts({
      text: "hi",
      startedAt: Date.now(),
      attachments: [
        {
          kind: "image",
          path: imagePath,
          name: "demo.png",
          mimeType: "image/png",
        },
      ],
    });
    assert.equal(restored.text, "hi");
    assert.equal(restored.images.length, 1);
    assert.equal(restored.images[0].mimeType, "image/png");
  });
});

test("koishi transport keeps prefixed text plus uniform image album together for telegram captions", () => {
  const batches = transport.planTelegramDeliveries([
    { type: "text", text: "intro" },
    { type: "image", path: "/tmp/1.png" },
    { type: "image", path: "/tmp/2.png" },
    { type: "image", path: "/tmp/3.png" },
  ]);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].map((part) => part.type),
    ["text", "image", "image", "image"],
  );
});

test("koishi transport compacts interleaved telegram text and multiple images into fewer batches", () => {
  const batches = transport.planTelegramDeliveries([
    { type: "text", text: "intro" },
    { type: "text", text: "first" },
    { type: "image", path: "/tmp/1.png" },
    { type: "text", text: "second" },
    { type: "image", path: "/tmp/2.png" },
  ]);
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches[0].map((part) => part.type),
    ["text", "text", "text"],
  );
  assert.deepEqual(
    batches[1].map((part) => part.type),
    ["image", "image"],
  );
});

test("koishi transport telegram compaction preserves asset-type order after stripping text labels", () => {
  const batches = transport.planTelegramDeliveries([
    { type: "text", text: "images" },
    { type: "image", path: "/tmp/1.png" },
    { type: "text", text: "files" },
    { type: "file", path: "/tmp/a.txt", name: "a.txt" },
    { type: "text", text: "more images" },
    { type: "image", path: "/tmp/2.png" },
  ]);
  assert.equal(batches.length, 4);
  assert.deepEqual(
    batches.map((batch) => batch[0].type),
    ["text", "image", "file", "image"],
  );
});

test("koishi transport keeps local image parts as file urls instead of inlining data urls", async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, "demo.png");
    await fs.writeFile(imagePath, Buffer.from("abc"));
    const h = Object.assign((type, attrs) => ({ type, attrs }), {
      image(src) {
        return { type: "img", attrs: { src } };
      },
      text(content) {
        return { type: "text", attrs: { content } };
      },
      at(id, options) {
        return { type: "at", attrs: { id, ...options } };
      },
      file(src, mimeType, options) {
        return { type: "file", attrs: { src, mimeType, ...options } };
      },
    });
    const node = await transport.messagePartToNode(
      { type: "image", path: imagePath, mimeType: "image/png" },
      h,
    );
    assert.equal(node.type, "image");
    assert.match(node.attrs.src, /^file:\/\//);
    assert.equal(node.attrs.mimeType, "image/png");
  });
});

test("koishi transport treats empty bot send results as delivery failures", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      transport.sendOutboxPayload(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "1",
              async sendMessage() {
                return [];
              },
            },
          ],
        },
        dir,
        {
          type: "parts_delivery",
          chatKey: "telegram/1:2",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          text(content) {
            return { type: "text", attrs: { content } };
          },
          quote(id) {
            return { type: "quote", attrs: { id } };
          },
        },
      ),
      /koishi_send_message_empty_result/,
    );
  });
});
