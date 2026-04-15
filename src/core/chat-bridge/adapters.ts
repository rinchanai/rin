export type ChatBridgeAdapterSetupKind = "telegram" | "onebot" | "json";

export type ChatBridgeAdapterSpec = {
  key: string;
  label: string;
  pluginKey: string;
  packageName: string;
  runtimePackageName?: string;
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
    packageName: "builtin:telegram",
    defaults: {
      protocol: "polling",
      token: "",
      slash: true,
    },
    installer: {
      kind: "telegram",
      placeholder:
        '{"token":"123456:ABCDEF...","protocol":"polling","slash":true}',
    },
  },
  {
    key: "onebot",
    label: "OneBot",
    pluginKey: "adapter-onebot",
    packageName: "builtin:onebot",
    defaults: {
      protocol: "ws",
      endpoint: "",
      selfId: "",
      token: "",
    },
    installer: {
      kind: "onebot",
      placeholder:
        '{"endpoint":"ws://127.0.0.1:3001","protocol":"ws","selfId":"","token":""}',
    },
  },
  {
    key: "qq",
    label: "QQ",
    pluginKey: "adapter-qq",
    packageName: "builtin:qq",
    defaults: {
      protocol: "websocket",
      sandbox: false,
      authType: "bearer",
    },
    installer: {
      kind: "json",
      placeholder: '{"id":"...","secret":"...","token":"..."}',
    },
  },
  {
    key: "lark",
    label: "Feishu / Lark",
    pluginKey: "adapter-lark",
    packageName: "builtin:lark",
    defaults: {
      protocol: "ws",
      platform: "feishu",
    },
    installer: {
      kind: "json",
      placeholder: '{"platform":"feishu","appId":"...","appSecret":"..."}',
    },
  },
  {
    key: "discord",
    label: "Discord",
    pluginKey: "adapter-discord",
    packageName: "builtin:discord",
    defaults: {},
    installer: { kind: "json", placeholder: '{"token":"..."}' },
  },
  {
    key: "slack",
    label: "Slack",
    pluginKey: "adapter-slack",
    packageName: "builtin:slack",
    defaults: {
      protocol: "ws",
    },
    installer: {
      kind: "json",
      placeholder: '{"protocol":"ws","token":"xapp-...","botToken":"xoxb-..."}',
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
