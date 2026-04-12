import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const rpc = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-koishi", "rpc.js"),
  ).href
);

test("koishi rpc uses an extended timeout for chat turns", () => {
  assert.equal(
    rpc.koishiRpcTimeoutMsFor({ type: "run_chat_turn" }),
    10 * 60_000,
  );
  assert.equal(
    rpc.koishiRpcTimeoutMsFor({ type: "send_chat" }),
    30_000,
  );
});
