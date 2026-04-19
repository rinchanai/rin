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
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);
const runtimeConfig = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "runtime-config.js"))
    .href
);
const adapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "adapters.js"),
  ).href
);

test("chat bridge adapter prompt options come from shared built-in specs", () => {
  const options = adapters.listChatBridgeAdapterPromptOptions();

  assert.deepEqual(
    options.find((item) => item.value === "telegram"),
    {
      value: "telegram",
      label: "Telegram",
      hint: "bot token",
    },
  );
  assert.deepEqual(
    options.find((item) => item.value === "onebot"),
    {
      value: "onebot",
      label: "OneBot",
      hint: "endpoint + protocol",
    },
  );
  assert.deepEqual(
    options.find((item) => item.value === "slack"),
    {
      value: "slack",
      label: "Slack",
      hint: "app token + bot token",
    },
  );
});

test("chat bridge adapter config materialization covers built-in official adapters", () => {
  const config = support.buildChatConfigFromSettings({
    chat: {
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
  const config = support.buildChatConfigFromSettings({
    chat: {
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
    chat: {
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

  const config = support.buildChatConfigFromSettings(settings);
  const runtimePackage = support.buildChatRuntimePackageJson(settings);

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

test("chat runtime package dependencies stay sorted and latest config wins per package", () => {
  const runtimePackage = support.buildChatRuntimePackageJson({
    chat: {
      customAdapters: [
        {
          packageName: "z-chat-bridge-adapter",
          version: "^1.0.0",
          pluginKey: "adapter-z-first",
          config: { token: "first" },
        },
        {
          packageName: "@scope/a-chat-bridge-adapter",
          version: "^2.0.0",
          pluginKey: "adapter-a",
          config: { token: "a" },
        },
        {
          packageName: "z-chat-bridge-adapter",
          version: "^3.0.0",
          pluginKey: "adapter-z-second",
          config: { token: "second" },
        },
      ],
    },
  });

  assert.deepEqual(runtimePackage.dependencies, {
    "@scope/a-chat-bridge-adapter": "^2.0.0",
    "z-chat-bridge-adapter": "^3.0.0",
  });
});

test("chat bridge runtime adapter entries use internal built-in runtime adapters", () => {
  const entries = support.listChatRuntimeAdapterEntries({
    chat: {
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

test("chat runtime config expands multi-entry adapters and strips setup-only metadata", () => {
  const settings = {
    chat: {
      telegram: [
        {
          name: "Alpha Bot",
          token: "telegram-alpha",
          owners: ["owner"],
          ownerUserIds: ["42"],
          botId: "tg-alpha",
        },
        {
          name: "Beta/Bot",
          token: "telegram-beta",
          slash: false,
        },
      ],
      customAdapters: [
        {
          packageName: "chat-bridge-adapter-example",
          pluginKey: "adapter-example",
          defaults: { region: "cn" },
          config: [
            {
              name: "Corp A",
              endpoint: "https://a.example.com",
              owners: ["owner"],
            },
            {
              name: "Corp/B",
              endpoint: "https://b.example.com",
              ownerUserIds: ["7"],
            },
          ],
        },
      ],
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-alpha",
    slash: true,
  });
  assert.deepEqual(config.plugins["adapter-telegram:Beta-Bot"], {
    protocol: "polling",
    token: "telegram-beta",
    slash: false,
  });
  assert.deepEqual(config.plugins["adapter-example"], {
    region: "cn",
    endpoint: "https://a.example.com",
  });
  assert.deepEqual(config.plugins["adapter-example:Corp-B"], {
    region: "cn",
    endpoint: "https://b.example.com",
  });
  assert.deepEqual(
    entries
      .filter((item) => item.key === "example")
      .map((item) => ({
        key: item.key,
        name: item.name,
        config: item.config,
        builtIn: item.builtIn,
        packageName: item.packageName,
      })),
    [
      {
        key: "example",
        name: "Corp-A",
        config: { region: "cn", endpoint: "https://a.example.com" },
        builtIn: false,
        packageName: "chat-bridge-adapter-example",
      },
      {
        key: "example",
        name: "Corp-B",
        config: { region: "cn", endpoint: "https://b.example.com" },
        builtIn: false,
        packageName: "chat-bridge-adapter-example",
      },
    ],
  );
});

test("chat runtime normalization expands named built-in and custom adapter maps", () => {
  const settings = {
    chat: {
      telegram: {
        "Alpha Bot": {
          token: "telegram-alpha",
        },
        beta: {
          name: "Beta/Bot",
          token: "telegram-beta",
          slash: false,
        },
      },
      customAdapters: [
        {
          packageName: "chat-bridge-adapter-example",
          pluginKey: "adapter-example",
          defaults: { region: "cn" },
          config: {
            "Corp A": {
              endpoint: "https://a.example.com",
            },
            corpB: {
              name: "Corp/B",
              endpoint: "https://b.example.com",
            },
          },
        },
      ],
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-alpha",
    slash: true,
  });
  assert.deepEqual(config.plugins["adapter-telegram:Beta-Bot"], {
    protocol: "polling",
    token: "telegram-beta",
    slash: false,
  });
  assert.deepEqual(config.plugins["adapter-example"], {
    region: "cn",
    endpoint: "https://a.example.com",
  });
  assert.deepEqual(config.plugins["adapter-example:Corp-B"], {
    region: "cn",
    endpoint: "https://b.example.com",
  });
  assert.deepEqual(
    entries
      .filter((item) => item.key === "telegram" || item.key === "example")
      .map((item) => ({
        key: item.key,
        name: item.name,
        config: item.config,
      })),
    [
      {
        key: "telegram",
        name: "Alpha-Bot",
        config: {
          protocol: "polling",
          token: "telegram-alpha",
          slash: true,
        },
      },
      {
        key: "telegram",
        name: "Beta-Bot",
        config: {
          protocol: "polling",
          token: "telegram-beta",
          slash: false,
        },
      },
      {
        key: "example",
        name: "Corp-A",
        config: {
          region: "cn",
          endpoint: "https://a.example.com",
        },
      },
      {
        key: "example",
        name: "Corp-B",
        config: {
          region: "cn",
          endpoint: "https://b.example.com",
        },
      },
    ],
  );
});

test("chat runtime normalization skips disabled adapters and entries", () => {
  const settings = {
    chat: {
      telegram: [
        {
          name: "Enabled Bot",
          token: "telegram-enabled",
        },
        {
          name: "Disabled Bot",
          token: "telegram-disabled",
          enabled: false,
        },
      ],
      customAdapters: [
        {
          packageName: "chat-bridge-adapter-disabled",
          pluginKey: "adapter-disabled",
          enabled: false,
          config: { token: "skip-me" },
        },
        {
          packageName: "chat-bridge-adapter-example",
          pluginKey: "adapter-example",
          config: [
            {
              name: "Enabled Entry",
              endpoint: "https://a.example.com",
            },
            {
              name: "Disabled Entry",
              endpoint: "https://b.example.com",
              enabled: false,
            },
          ],
        },
      ],
    },
  };

  const config = runtimeConfig.buildChatConfigFromSettings(settings);
  const entries = runtimeConfig.listChatRuntimeAdapterEntries(settings);
  const runtimePackage = runtimeConfig.buildChatRuntimePackageJson(settings);

  assert.deepEqual(config.plugins["adapter-telegram"], {
    protocol: "polling",
    token: "telegram-enabled",
    slash: true,
  });
  assert.equal("adapter-telegram:Disabled-Bot" in config.plugins, false);
  assert.deepEqual(config.plugins["adapter-example"], {
    endpoint: "https://a.example.com",
  });
  assert.equal("adapter-example:Disabled-Entry" in config.plugins, false);
  assert.deepEqual(
    entries.map((item) => ({ key: item.key, name: item.name })),
    [
      { key: "telegram", name: "Enabled-Bot" },
      { key: "example", name: "Enabled-Entry" },
    ],
  );
  assert.deepEqual(runtimePackage.dependencies, {
    "chat-bridge-adapter-example": "latest",
  });
});

test("chat support re-exports chat runtime config helpers", () => {
  assert.equal(
    support.buildChatConfigFromSettings,
    runtimeConfig.buildChatConfigFromSettings,
  );
  assert.equal(
    support.listChatRuntimeAdapterEntries,
    runtimeConfig.listChatRuntimeAdapterEntries,
  );
  assert.equal(
    support.buildChatRuntimePackageJson,
    runtimeConfig.buildChatRuntimePackageJson,
  );
});

test("chat bridge runtime dependency install check only triggers for custom adapter packages", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-bridge-runtime-"),
  );
  try {
    assert.equal(
      support.shouldInstallChatRuntimeDependencies(dir, {
        chat: {
          telegram: { token: "telegram-token", protocol: "polling" },
        },
      }),
      false,
    );

    const settings = {
      chat: {
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
      support.shouldInstallChatRuntimeDependencies(dir, settings),
      true,
    );

    const runtimePackage = support.buildChatRuntimePackageJson(settings);
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
      support.shouldInstallChatRuntimeDependencies(dir, settings),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
