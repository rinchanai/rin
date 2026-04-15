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
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-koishi", "support.js"))
    .href
);

test("chat bridge adapter config materialization covers built-in official adapters", () => {
  const config = support.buildKoishiConfigFromSettings({
    koishi: {
      discord: { token: "discord-token" },
      zulip: { server: "https://zulip.example.com", email: "bot@example.com" },
      wecom: [
        {
          name: "corp-a",
          corpId: "corp-id",
          agentId: "1000001",
          secret: "secret",
        },
      ],
    },
  });

  assert.deepEqual(config.plugins["adapter-discord"], {
    token: "discord-token",
  });
  assert.deepEqual(config.plugins["adapter-zulip"], {
    server: "https://zulip.example.com",
    email: "bot@example.com",
  });
  assert.deepEqual(config.plugins["adapter-wecom"], {
    corpId: "corp-id",
    agentId: "1000001",
    secret: "secret",
  });
});

test("chat bridge config materialization includes custom koishi adapters and runtime package deps", () => {
  const settings = {
    koishi: {
      customAdapters: [
        {
          packageName: "koishi-plugin-adapter-example",
          version: "^1.2.3",
          pluginKey: "adapter-example",
          config: {
            token: "demo-token",
          },
        },
        {
          packageName: "@scope/koishi-plugin-adapter-multi",
          pluginKey: "adapter-multi",
          config: [
            {
              name: "corp-a",
              endpoint: "https://a.example.com",
            },
          ],
        },
      ],
    },
  };

  const config = support.buildKoishiConfigFromSettings(settings);
  const runtimePackage = support.buildKoishiRuntimePackageJson(settings);

  assert.deepEqual(config.plugins["adapter-example"], {
    token: "demo-token",
  });
  assert.deepEqual(config.plugins["adapter-multi"], {
    endpoint: "https://a.example.com",
  });
  assert.deepEqual(runtimePackage.dependencies, {
    "@scope/koishi-plugin-adapter-multi": "latest",
    "koishi-plugin-adapter-example": "^1.2.3",
  });
});

test("chat bridge runtime dependency install check only triggers when custom adapter packages are missing or changed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-bridge-runtime-"));
  try {
    const settings = {
      koishi: {
        customAdapters: [
          {
            packageName: "@scope/koishi-plugin-adapter-multi",
            pluginKey: "adapter-multi",
            config: { token: "x" },
          },
        ],
      },
    };

    assert.equal(support.shouldInstallKoishiRuntimeDependencies(dir, settings), true);

    const runtimePackage = support.buildKoishiRuntimePackageJson(settings);
    await fs.writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify(runtimePackage, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(dir, "package-lock.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(dir, "node_modules", "@scope", "koishi-plugin-adapter-multi"), {
      recursive: true,
    });

    assert.equal(support.shouldInstallKoishiRuntimeDependencies(dir, settings), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
