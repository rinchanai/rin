import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { RinDaemonFrontendClient } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "rpc-client.js"))
    .href
);

test("rpc client submit routes builtin slash commands through run_command", async () => {
  const sent = [];
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.send = async (payload) => {
    sent.push(payload);
    return { success: true, data: {} };
  };
  client.isConnected = () => true;

  await client.submit("/model");

  assert.deepEqual(sent, [{ type: "run_command", commandLine: "/model" }]);
});

test("rpc client submit routes extension slash commands through run_command", async () => {
  const sent = [];
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.send = async (payload) => {
    sent.push(payload);
    if (payload.type === "get_commands") {
      return {
        success: true,
        data: {
          commands: [
            {
              name: "chat",
              description: "Configure chat bridge",
              source: "extension",
            },
          ],
        },
      };
    }
    return { success: true, data: {} };
  };
  client.isConnected = () => true;

  await client.submit("/chat");

  assert.deepEqual(sent, [
    { type: "get_commands" },
    { type: "run_command", commandLine: "/chat" },
  ]);
});

test("rpc client submit keeps prompt templates on prompt path", async () => {
  const sent = [];
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.send = async (payload) => {
    sent.push(payload);
    if (payload.type === "get_commands") {
      return {
        success: true,
        data: {
          commands: [
            {
              name: "template-demo",
              description: "Prompt template",
              source: "prompt",
            },
          ],
        },
      };
    }
    return { success: true, data: {} };
  };
  client.isConnected = () => true;

  await client.submit("/template-demo abc");

  assert.deepEqual(sent, [
    { type: "get_commands" },
    { type: "prompt", message: "/template-demo abc" },
  ]);
});

test("rpc client submit keeps normal text on prompt path", async () => {
  const sent = [];
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.send = async (payload) => {
    sent.push(payload);
    return { success: true, data: {} };
  };
  client.isConnected = () => true;

  await client.submit("hello");

  assert.deepEqual(sent, [{ type: "prompt", message: "hello" }]);
});
