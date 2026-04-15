export type ChatBridgeAdapterSetupKind = "telegram" | "onebot" | "json";

export type ChatBridgeAdapterSpec = {
  key: string;
  label: string;
  pluginKey: string;
  packageName: string;
  defaults: Record<string, any>;
  installer: {
    kind: ChatBridgeAdapterSetupKind;
    placeholder?: string;
  };
};

const CHAT_BRIDGE_ADAPTER_SPECS: readonly ChatBridgeAdapterSpec[] = [
  {
    key: "telegram",
    label: "Telegram",
    pluginKey: "adapter-telegram",
    packageName: "@koishijs/plugin-adapter-telegram",
    defaults: {
      protocol: "polling",
      token: "",
      slash: true,
    },
    installer: {
      kind: "telegram",
      placeholder: '{"token":"123456:ABCDEF...","protocol":"polling","slash":true}',
    },
  },
  {
    key: "onebot",
    label: "OneBot",
    pluginKey: "adapter-onebot",
    packageName: "koishi-plugin-adapter-onebot",
    defaults: {
      protocol: "ws",
      endpoint: "",
      selfId: "",
      token: "",
    },
    installer: {
      kind: "onebot",
      placeholder: '{"endpoint":"ws://127.0.0.1:3001","protocol":"ws","selfId":"","token":""}',
    },
  },
  {
    key: "discord",
    label: "Discord",
    pluginKey: "adapter-discord",
    packageName: "@koishijs/plugin-adapter-discord",
    defaults: {},
    installer: { kind: "json", placeholder: '{"token":"..."}' },
  },
  {
    key: "kook",
    label: "Kook",
    pluginKey: "adapter-kook",
    packageName: "@koishijs/plugin-adapter-kook",
    defaults: {},
    installer: { kind: "json", placeholder: '{"token":"..."}' },
  },
  {
    key: "qq",
    label: "QQ",
    pluginKey: "adapter-qq",
    packageName: "@koishijs/plugin-adapter-qq",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"id":"...","secret":"...","token":"..."}',
    },
  },
  {
    key: "lark",
    label: "Lark",
    pluginKey: "adapter-lark",
    packageName: "@koishijs/plugin-adapter-lark",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"appId":"...","appSecret":"..."}',
    },
  },
  {
    key: "mail",
    label: "Mail",
    pluginKey: "adapter-mail",
    packageName: "@koishijs/plugin-adapter-mail",
    defaults: {},
    installer: {
      kind: "json",
      placeholder:
        '{"transport":{"host":"smtp.example.com","port":465,"secure":true,"auth":{"user":"bot@example.com","pass":"..."}},"from":"bot@example.com"}',
    },
  },
  {
    key: "wechat-official",
    label: "WeChat Official",
    pluginKey: "adapter-wechat-official",
    packageName: "@koishijs/plugin-adapter-wechat-official",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"appId":"...","appSecret":"..."}',
    },
  },
  {
    key: "wecom",
    label: "WeCom",
    pluginKey: "adapter-wecom",
    packageName: "@koishijs/plugin-adapter-wecom",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"corpId":"...","agentId":"...","secret":"..."}',
    },
  },
  {
    key: "dingtalk",
    label: "DingTalk",
    pluginKey: "adapter-dingtalk",
    packageName: "@koishijs/plugin-adapter-dingtalk",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"appKey":"...","appSecret":"..."}',
    },
  },
  {
    key: "matrix",
    label: "Matrix",
    pluginKey: "adapter-matrix",
    packageName: "@koishijs/plugin-adapter-matrix",
    defaults: {},
    installer: {
      kind: "json",
      placeholder:
        '{"homeserver":"https://matrix.example.com","userId":"@bot:example.com","accessToken":"..."}',
    },
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    pluginKey: "adapter-whatsapp",
    packageName: "@koishijs/plugin-adapter-whatsapp",
    defaults: {},
    installer: { kind: "json", placeholder: '{"token":"..."}' },
  },
  {
    key: "line",
    label: "LINE",
    pluginKey: "adapter-line",
    packageName: "@koishijs/plugin-adapter-line",
    defaults: {},
    installer: {
      kind: "json",
      placeholder: '{"channelAccessToken":"...","channelSecret":"..."}',
    },
  },
  {
    key: "slack",
    label: "Slack",
    pluginKey: "adapter-slack",
    packageName: "@koishijs/plugin-adapter-slack",
    defaults: {},
    installer: { kind: "json", placeholder: '{"token":"..."}' },
  },
  {
    key: "zulip",
    label: "Zulip",
    pluginKey: "adapter-zulip",
    packageName: "@koishijs/plugin-adapter-zulip",
    defaults: {},
    installer: {
      kind: "json",
      placeholder:
        '{"server":"https://zulip.example.com","email":"bot@example.com","apiKey":"..."}',
    },
  },
];

const CHAT_BRIDGE_ADAPTER_SPEC_MAP = new Map(
  CHAT_BRIDGE_ADAPTER_SPECS.map((item) => [item.key, item]),
);

export function listChatBridgeAdapterSpecs() {
  return [...CHAT_BRIDGE_ADAPTER_SPECS];
}

export function getChatBridgeAdapterSpec(key: string) {
  return CHAT_BRIDGE_ADAPTER_SPEC_MAP.get(String(key || "").trim());
}

export function listSupportedChatBridgeLabels() {
  return CHAT_BRIDGE_ADAPTER_SPECS.map((item) => item.label);
}
