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
const messageContent = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "message-content.js")).href,
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-message-content-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("message content helpers extract text with optional thinking and trimming", () => {
  assert.equal(messageContent.extractMessageText("  raw text  "), "  raw text  ");
  assert.equal(
    messageContent.extractMessageText([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: " done " },
    ]),
    " done ",
  );
  assert.equal(
    messageContent.extractMessageText(
      [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: " done " },
      ],
      { includeThinking: true, trim: true },
    ),
    "plan done",
  );
});

test("message content helpers extract valid image parts and default mime types", () => {
  assert.deepEqual(
    messageContent.extractImageParts([
      { type: "text", text: "ignore" },
      { type: "image", data: "aaa" },
      { type: "image", data: "bbb", mimeType: "image/webp" },
      { type: "image", data: "" },
    ]),
    [
      { data: "aaa", mimeType: "image/png" },
      { data: "bbb", mimeType: "image/webp" },
    ],
  );
});

test("message content helpers extract tool call parts, names, and counts", () => {
  const bashCall = { type: "toolCall", id: "1", name: "bash" };
  const readCall = { type: "toolCall", id: "2", toolName: "read" };
  const unnamedCall = { type: "toolCall", id: "3", name: "   " };

  assert.deepEqual(
    messageContent.extractToolCallParts([
      { type: "text", text: "ignore" },
      bashCall,
      readCall,
      unnamedCall,
      { type: "toolCall", id: "4", name: "bash" },
    ]),
    [bashCall, readCall, unnamedCall, { type: "toolCall", id: "4", name: "bash" }],
  );
  assert.deepEqual(
    messageContent.extractToolCallNames([
      bashCall,
      readCall,
      unnamedCall,
      { type: "toolCall", id: "4", name: "bash" },
    ]),
    ["bash", "read"],
  );
  assert.equal(
    messageContent.countToolCalls([
      { type: "text", text: "ignore" },
      bashCall,
      readCall,
      unnamedCall,
    ]),
    3,
  );
  assert.deepEqual(messageContent.extractToolCallParts("not-an-array"), []);
});

test("message content helpers resolve only explicit existing file URLs", async () => {
  await withTempDir(async (dir) => {
    const first = path.join(dir, "first.txt");
    const second = path.join(dir, "second.txt");
    await fs.writeFile(first, "one", "utf8");
    await fs.writeFile(second, "two", "utf8");

    assert.deepEqual(
      messageContent.extractExistingFilePaths(
        [
          `file://${first}`,
          `file://${first}`,
          `plain path ${second}`,
          `file://${second}`,
          `file://${path.join(dir, "missing.txt")}`,
        ].join("\n"),
      ),
      [first, second],
    );
  });
});
