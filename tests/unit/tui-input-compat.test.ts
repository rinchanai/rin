import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const inputCompat = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "input-compat.js"),
  ).href
);

test("tui input compat identifies the explicit newline shortcut", () => {
  assert.equal(inputCompat.isExplicitNewlineInput("\n"), true);
  assert.equal(inputCompat.isExplicitNewlineInput("a"), false);
  assert.equal(inputCompat.isExplicitNewlineInput(""), false);
});

test("tui input compat registers the editor replacement on session start", () => {
  let eventName = "";
  let handler;
  const pi = {
    on(name, callback) {
      eventName = name;
      handler = callback;
    },
  };

  inputCompat.default(pi);
  assert.equal(eventName, "session_start");
  assert.equal(typeof handler, "function");

  let componentFactory;
  handler(
    {},
    {
      ui: {
        setEditorComponent(factory) {
          componentFactory = factory;
        },
      },
    },
  );

  assert.equal(typeof componentFactory, "function");
});
