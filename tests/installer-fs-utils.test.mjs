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
const fsUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "fs-utils.js"),
  ).href
);

test("installer fs utils compute launcher targets and script", () => {
  const targets = fsUtils.launcherTargetsForInstallDir("/tmp/rin");
  assert.ok(
    targets.rin[0].endsWith(path.join("dist", "app", "rin", "main.js")),
  );
  const script = fsUtils.launcherScript(["/tmp/a.js", "/tmp/b.js"]);
  assert.ok(script.includes("installed runtime entry not found"));
  assert.ok(script.includes("/tmp/a.js"));
});

test("publishInstalledRuntime rebuilds vendored coding-agent dist when missing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-src-"));
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-dst-"),
  );

  await fs.mkdir(path.join(tempRoot, "dist", "app", "rin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, "dist", "app", "rin", "main.js"),
    "export {};",
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "extensions"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "package.json"), "{\n}\n", "utf8");
  await fs.copyFile(
    path.join(rootDir, "tsconfig.base.json"),
    path.join(tempRoot, "tsconfig.base.json"),
  );

  const vendorRoot = path.join(tempRoot, "third_party", "pi-coding-agent");
  await fs.mkdir(path.dirname(vendorRoot), { recursive: true });
  await fs.cp(
    path.join(rootDir, "third_party", "pi-coding-agent", "src"),
    path.join(vendorRoot, "src"),
    {
      recursive: true,
    },
  );
  await fs.copyFile(
    path.join(rootDir, "third_party", "pi-coding-agent", "package.json"),
    path.join(vendorRoot, "package.json"),
  );
  await fs.copyFile(
    path.join(rootDir, "third_party", "pi-coding-agent", "tsconfig.build.json"),
    path.join(vendorRoot, "tsconfig.build.json"),
  );

  await fs.symlink(
    path.join(rootDir, "node_modules"),
    path.join(tempRoot, "node_modules"),
  );

  const published = fsUtils.publishInstalledRuntime(
    tempRoot,
    installDir,
    "rin",
    false,
    { findSystemUser: () => null },
  );

  await fs.access(
    path.join(
      published.releaseRoot,
      "third_party",
      "pi-coding-agent",
      "dist",
      "core",
      "session-manager.js",
    ),
  );
  await fs.access(
    path.join(
      published.releaseRoot,
      "third_party",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
      "dark.json",
    ),
  );
});
