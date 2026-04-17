import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const taskIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "task", "index.js")).href,
);

test("save_task exposes in-place update id and dedicated default read-and-burn semantics", () => {
  const tools = [];
  taskIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const saveTool = tools.find((tool) => tool.name === "save_task");
  assert.ok(saveTool);
  assert.equal(saveTool.parameters.properties.id.type, "string");
  assert.equal(
    saveTool.parameters.properties.session.properties.sessionFile.type,
    "string",
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /read-and-burn by default/,
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.sessionFile.description || "",
    ),
    /seed or resume a persistent dedicated session explicitly/,
  );
});
