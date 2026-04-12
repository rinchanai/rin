import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const delivery = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "delivery.js"))
    .href
);

test("koishi delivery resolves final text directly from completion payload when present", async () => {
  const controller = {
    latestAssistantText: "stale latest",
    interimText: "stale interim",
    refreshSessionMessages: async () => {
      throw new Error(
        "should not refresh when completion already has final text",
      );
    },
    session: {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "stale message" }],
        },
      ],
    },
  };

  const finalText = await delivery.resolveFinalAssistantText(controller, {
    finalText: "fresh completion text",
  });

  assert.equal(finalText, "fresh completion text");
});

test("koishi delivery retries session refresh before falling back to interim text", async () => {
  const controller = {
    latestAssistantText: "",
    interimText: "visible interim",
    session: { messages: [] },
  };
  let refreshCalls = 0;
  controller.refreshSessionMessages = async () => {
    refreshCalls += 1;
    if (refreshCalls === 2) {
      controller.session.messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "refreshed final text" }],
        },
      ];
    }
  };

  const finalText = await delivery.resolveFinalAssistantText(
    controller,
    undefined,
  );

  assert.equal(finalText, "refreshed final text");
  assert.equal(refreshCalls, 2);
});

test("koishi delivery completes live turns with refreshed final text and session metadata", async () => {
  const resolved = [];
  const controller = {
    latestAssistantText: "",
    interimText: "",
    session: { messages: [] },
    liveTurn: {
      resolve(value) {
        resolved.push(value);
      },
    },
    currentSessionId() {
      return "session-42";
    },
    currentSessionFile() {
      return "/tmp/session-42.jsonl";
    },
  };
  let refreshCalls = 0;
  controller.refreshSessionMessages = async () => {
    refreshCalls += 1;
    controller.session.messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "completed final text" }],
      },
    ];
  };

  await delivery.completeLiveTurn(controller);

  assert.equal(refreshCalls, 1);
  assert.equal(controller.latestAssistantText, "completed final text");
  assert.deepEqual(resolved, [
    {
      finalText: "completed final text",
      sessionId: "session-42",
      sessionFile: "/tmp/session-42.jsonl",
    },
  ]);
});
