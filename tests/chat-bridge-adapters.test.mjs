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
      qq: {
        id: "qq-app-id",
        secret: "qq-secret",
        token: "qq-token",
        type: "public",
      },
      lark: [
        {
          name: "corp-a",
          appId: "cli_xxx",
          appSecret: "secret",
        },
      ],
    },
  });

  assert.deepEqual(config.plugins["adapter-discord"], {
    token: "discord-token",
  });
  assert.deepEqual(config.plugins["adapter-qq"], {
    protocol: "websocket",
    sandbox: false,
    authType: "bearer",
    id: "qq-app-id",
    secret: "qq-secret",
    token: "qq-token",
    type: "public",
  });
  assert.deepEqual(config.plugins["adapter-lark"], {
    protocol: "ws",
    platform: "feishu",
    appId: "cli_xxx",
    appSecret: "secret",
  });
});

test("chat bridge adapter config materialization applies minimal setup defaults", () => {
  const config = support.buildKoishiConfigFromSettings({
    koishi: {
      qq: { id: "app-id", secret: "secret", token: "token", type: "public" },
      lark: { appId: "cli_xxx", appSecret: "secret_xxx" },
      slack: { token: "xapp-demo", botToken: "xoxb-demo" },
    },
  });

  assert.deepEqual(config.plugins["adapter-qq"], {
    protocol: "websocket",
    sandbox: false,
    authType: "bearer",
    id: "app-id",
    secret: "secret",
    token: "token",
    type: "public",
  });
  assert.deepEqual(config.plugins["adapter-lark"], {
    protocol: "ws",
    platform: "feishu",
    appId: "cli_xxx",
    appSecret: "secret_xxx",
  });
  assert.deepEqual(config.plugins["adapter-slack"], {
    protocol: "ws",
    token: "xapp-demo",
    botToken: "xoxb-demo",
  });
});

test("chat bridge config materialization includes custom adapters and runtime package deps", () => {
  const settings = {
    koishi: {
      customAdapters: [
        {
          packageName: "chat-bridge-adapter-example",
          version: "^1.2.3",
          pluginKey: "adapter-example",
          config: {
            token: "demo-token",
          },
        },
        {
          packageName: "@scope/chat-bridge-adapter-multi",
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
    "@scope/chat-bridge-adapter-multi": "latest",
    "chat-bridge-adapter-example": "^1.2.3",
  });
});

test("chat bridge runtime adapter entries use internal built-in runtime adapters", () => {
  const entries = support.listKoishiRuntimeAdapterEntries({
    koishi: {
      telegram: { token: "telegram-token", protocol: "polling" },
      onebot: { endpoint: "ws://127.0.0.1:3001", protocol: "ws", selfId: "42" },
      minecraft: { url: "ws://127.0.0.1:8080", selfId: "minecraft" },
    },
  });

  assert.deepEqual(
    entries.map((item) => ({ key: item.key, builtIn: item.builtIn })),
    [
      { key: "telegram", builtIn: true },
      { key: "onebot", builtIn: true },
      { key: "minecraft", builtIn: true },
    ],
  );
});

test("chat bridge runtime dependency install check only triggers for custom adapter packages", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-bridge-runtime-"),
  );
  try {
    assert.equal(
      support.shouldInstallKoishiRuntimeDependencies(dir, {
        koishi: {
          telegram: { token: "telegram-token", protocol: "polling" },
        },
      }),
      false,
    );

    const settings = {
      koishi: {
        telegram: { token: "telegram-token", protocol: "polling" },
        customAdapters: [
          {
            packageName: "@scope/chat-bridge-adapter-multi",
            pluginKey: "adapter-multi",
            config: { token: "x" },
          },
        ],
      },
    };

    assert.equal(
      support.shouldInstallKoishiRuntimeDependencies(dir, settings),
      true,
    );

    const runtimePackage = support.buildKoishiRuntimePackageJson(settings);
    await fs.writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify(runtimePackage, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(dir, "package-lock.json"), "{}\n", "utf8");
    for (const dep of Object.keys(runtimePackage.dependencies)) {
      await fs.mkdir(path.join(dir, "node_modules", ...dep.split("/")), {
        recursive: true,
      });
    }

    assert.equal(
      support.shouldInstallKoishiRuntimeDependencies(dir, settings),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
