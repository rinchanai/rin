import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const systemMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "system.js")).href
);

test("isTmuxNoServerError matches missing tmux socket cases", () => {
  assert.equal(
    systemMod.isTmuxNoServerError(
      1,
      "error connecting to /tmp/tmux-1001/rin-rin (No such file or directory)\n",
    ),
    true,
  );
  assert.equal(
    systemMod.isTmuxNoServerError(
      1,
      "error connecting to /tmp/tmux-1001/rin-rin (Connection refused)\n",
    ),
    true,
  );
  assert.equal(
    systemMod.isTmuxNoServerError(
      1,
      "no server running on /tmp/tmux-1001/default\n",
    ),
    true,
  );
  assert.equal(systemMod.isTmuxNoServerError(1, "permission denied\n"), false);
  assert.equal(systemMod.isTmuxNoServerError(0, ""), false);
});
