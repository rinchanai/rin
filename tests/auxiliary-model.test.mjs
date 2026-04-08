import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const mod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "auxiliary-model.js"),
  ).href
);

test("loadAuxiliaryModelConfig reads auxiliaryModel from settings.json", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-aux-model-"));
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        auxiliaryModel: {
          model: "openai/gpt-5.4-mini",
          thinkingLevel: "low",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const config = await mod.loadAuxiliaryModelConfig(agentDir);
  assert.equal(config.modelRef, "openai/gpt-5.4-mini");
  assert.equal(config.thinkingLevel, "low");
});
