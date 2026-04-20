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
const users = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "users.js"))
    .href,
);

async function withTempDir(fn) {
  await fs.mkdir("/home/rin/tmp", { recursive: true });
  const dir = await fs.mkdtemp(path.join("/home/rin/tmp", "rin-installer-users-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("installer users keep system user lists deterministically sorted", () => {
  const listed = users.listSystemUsers();
  for (let index = 1; index < listed.length; index += 1) {
    const previous = listed[index - 1];
    const current = listed[index];
    assert.ok(
      previous.uid < current.uid ||
        (previous.uid === current.uid && previous.name.localeCompare(current.name) <= 0),
    );
  }
});

test("installer users normalize lookup and home fallback behavior", () => {
  assert.equal(users.findSystemUser("   "), undefined);
  assert.equal(users.homeForUser(" demo-user "), "/home/demo-user");
  assert.equal(users.targetHomeForUser(" demo-user "), "/home/demo-user");
});

test("installer users describe ownership and elevated write decisions consistently", async () => {
  await withTempDir(async (dir) => {
    const currentUser = os.userInfo().username;
    const ownership = users.describeOwnership(` ${currentUser} `, dir);

    assert.equal(ownership.writable, true);
    assert.equal(Number.isInteger(ownership.statUid), true);
    assert.equal(Number.isInteger(ownership.statGid), true);
    assert.equal(users.shouldUseElevatedWrite(` ${currentUser} `, ownership), false);
    assert.equal(users.shouldUseElevatedWrite("other-user", ownership), true);

    const missing = users.describeOwnership("missing-user", path.join(dir, "missing"));
    assert.deepEqual(missing, {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid: -1,
      targetGid: -1,
    });
  });
});
