import {
  getChatBridgeAdapterSpec,
  listChatBridgeAdapterPromptOptions,
} from "./adapters.js";
import type { ChatBridgeBuiltInAdapterKey } from "./adapters.js";
import { safeString } from "../text-utils.js";

export type ChatBridgePromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type ChatBridgeSetupResult = {
  adapterKey: string;
  chatDescription: string;
  chatDetail: string;
  chatConfig: any;
};

type ChatBridgePromptFieldValue = string | undefined;
type ChatBridgePromptFieldValues = Record<string, ChatBridgePromptFieldValue>;

type ChatBridgeTextPromptFieldSpec = {
  kind: "text" | "url";
  key: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  validate?: (value: string) => string | void;
};

type ChatBridgeSelectPromptFieldSpec<T extends string = string> = {
  kind: "select";
  key: string;
  message: string;
  values: Array<{ value: T; label: string; hint?: string }>;
};

type ChatBridgePromptFieldSpec =
  | ChatBridgeTextPromptFieldSpec
  | ChatBridgeSelectPromptFieldSpec;

type ChatBridgeAdapterPromptResult = {
  detail: string;
  config: any;
};

type ChatBridgeAdapterPromptHandler = (
  prompt: ChatBridgePromptApi,
) => Promise<ChatBridgeAdapterPromptResult>;

type ChatBridgeAdapterPromptDefinition = {
  fields: readonly ChatBridgePromptFieldSpec[];
  detail: (values: ChatBridgePromptFieldValues) => string;
  config: (values: ChatBridgePromptFieldValues) => any;
};

const TELEGRAM_BOTFATHER_URL = "https://t.me/BotFather";
const ONEBOT_DOCS_URL = "https://11.onebot.dev/";
const QQ_BOT_DOCS_URL = "https://bot.q.qq.com/wiki/develop/api-v2/";
const FEISHU_LARK_APP_LINKS = [
  "Feishu https://open.feishu.cn/app?lang=zh-CN",
  "Lark https://open.larksuite.com/",
];
const SLACK_APPS_URL = "https://api.slack.com/apps";

function withGuide(message: string, guide?: string, links?: string | string[]) {
  const main = safeString(message).trim();
  const extra = safeString(guide).trim();
  const linkList = (Array.isArray(links) ? links : [links])
    .map((item) => safeString(item).trim())
    .filter(Boolean);
  const lines = [main];
  if (extra) lines.push(`Where to find it: ${extra}`);
  if (linkList.length) lines.push(`Open: ${linkList.join(" · ")}`);
  return lines.join("\n");
}

function textField(
  key: string,
  options: Omit<ChatBridgeTextPromptFieldSpec, "kind" | "key">,
): ChatBridgeTextPromptFieldSpec {
  return { kind: "text", key, ...options };
}

function urlField(
  key: string,
  options: Omit<ChatBridgeTextPromptFieldSpec, "kind" | "key">,
): ChatBridgeTextPromptFieldSpec {
  return { kind: "url", key, ...options };
}

function selectField<T extends string>(
  key: string,
  options: Omit<ChatBridgeSelectPromptFieldSpec<T>, "kind" | "key">,
): ChatBridgeSelectPromptFieldSpec<T> {
  return { kind: "select", key, ...options };
}

async function promptText(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | void;
  },
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        validate(value: string) {
          const next = String(value || "").trim();
          if (options.required && !next) return "This field is required.";
          return options.validate?.(next);
        },
      }),
    ),
  ).trim();
}

async function promptSelectValue<T extends string>(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    values: Array<{ value: T; label: string; hint?: string }>;
  },
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: options.message,
        options: options.values,
      }),
    ),
  ) as T;
}

async function promptFieldValue(
  prompt: ChatBridgePromptApi,
  field: ChatBridgePromptFieldSpec,
): Promise<ChatBridgePromptFieldValue> {
  if (field.kind === "select") {
    return await promptSelectValue(prompt, {
      message: field.message,
      values: field.values,
    });
  }

  const value = await promptText(prompt, {
    message: field.message,
    placeholder: field.placeholder,
    defaultValue: field.defaultValue,
    required: field.required,
    validate(value) {
      if (field.kind === "url") {
        if (!value && !field.required) return;
        try {
          new URL(value);
        } catch {
          return "Use a valid URL.";
        }
      }
      return field.validate?.(value);
    },
  });
  return value || undefined;
}

async function promptFieldValues(
  prompt: ChatBridgePromptApi,
  fields: readonly ChatBridgePromptFieldSpec[],
) {
  const values: ChatBridgePromptFieldValues = {};
  for (const field of fields) {
    values[field.key] = await promptFieldValue(prompt, field);
  }
  return values;
}

function compactObject<T extends Record<string, any>>(value: T) {
  const next: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string" && !item.trim()) continue;
    next[key] = item;
  }
  return next as T;
}

function getEndpointProtocol(endpoint: string | undefined) {
  return /^https?:\/\//i.test(String(endpoint || "")) ? "http" : "ws";
}

function createPromptHandler(
  definition: ChatBridgeAdapterPromptDefinition,
): ChatBridgeAdapterPromptHandler {
  return async (prompt) => {
    const values = await promptFieldValues(prompt, definition.fields);
    return {
      detail: definition.detail(values),
      config: definition.config(values),
    };
  };
}

const TELEGRAM_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  textField("token", {
    message: withGuide(
      "Enter the Telegram bot token.",
      "Telegram @BotFather → choose your bot → API token.",
      TELEGRAM_BOTFATHER_URL,
    ),
    placeholder: "123456:ABCDEF...",
    required: true,
  }),
];

const ONEBOT_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  urlField("endpoint", {
    message: withGuide(
      "Enter the OneBot endpoint URL.",
      "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
      ONEBOT_DOCS_URL,
    ),
    placeholder: "ws://127.0.0.1:3001",
    required: true,
  }),
  textField("selfId", {
    message: withGuide(
      "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
      "Usually the bot QQ number from your OneBot client or bridge config.",
      ONEBOT_DOCS_URL,
    ),
    placeholder: "123456789",
  }),
  textField("token", {
    message: withGuide(
      "Enter the OneBot access token if required. Leave blank otherwise.",
      "Use the access token from your OneBot server config only if you enabled one.",
      ONEBOT_DOCS_URL,
    ),
    placeholder: "optional token",
  }),
];

const DISCORD_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  textField("token", {
    message: withGuide(
      "Enter the Discord bot token.",
      "Discord Developer Portal → your application → Bot → Reset Token / Token.",
      "https://discord.com/developers/applications",
    ),
    placeholder: "Bot token",
    required: true,
  }),
];

const QQ_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  textField("id", {
    message: withGuide(
      "Enter the QQ bot app ID.",
      "QQ bot developer docs → create your bot application → app credentials.",
      QQ_BOT_DOCS_URL,
    ),
    placeholder: "App ID",
    required: true,
  }),
  textField("secret", {
    message: withGuide(
      "Enter the QQ bot secret.",
      "QQ bot developer docs → create your bot application → app credentials.",
      QQ_BOT_DOCS_URL,
    ),
    placeholder: "Secret",
    required: true,
  }),
  textField("token", {
    message: withGuide(
      "Enter the QQ bot token.",
      "QQ bot developer docs → your bot application → token / credentials.",
      QQ_BOT_DOCS_URL,
    ),
    placeholder: "Token",
    required: true,
  }),
  selectField("type", {
    message: withGuide(
      "Choose the QQ bot scope.",
      "Use the bot type shown in your QQ bot application settings.",
      QQ_BOT_DOCS_URL,
    ),
    values: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
  }),
];

const LARK_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  selectField("platform", {
    message: withGuide(
      "Choose the Lark / Feishu region.",
      "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
      FEISHU_LARK_APP_LINKS,
    ),
    values: [
      { value: "feishu", label: "Feishu", hint: "China / open.feishu.cn" },
      { value: "lark", label: "Lark", hint: "Global / open.larksuite.com" },
    ],
  }),
  textField("appId", {
    message: withGuide(
      "Enter the Lark / Feishu app ID.",
      "Developer console → your app → Credentials / Basic information.",
      FEISHU_LARK_APP_LINKS,
    ),
    placeholder: "App ID",
    required: true,
  }),
  textField("appSecret", {
    message: withGuide(
      "Enter the Lark / Feishu app secret.",
      "Developer console → your app → Credentials / Basic information.",
      FEISHU_LARK_APP_LINKS,
    ),
    placeholder: "App secret",
    required: true,
  }),
];

const SLACK_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  textField("token", {
    message: withGuide(
      "Enter the Slack app-level token.",
      "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
      SLACK_APPS_URL,
    ),
    placeholder: "xapp-...",
    required: true,
  }),
  textField("botToken", {
    message: withGuide(
      "Enter the Slack bot token.",
      "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
      SLACK_APPS_URL,
    ),
    placeholder: "xoxb-...",
    required: true,
  }),
];

const MINECRAFT_PROMPT_FIELDS: readonly ChatBridgePromptFieldSpec[] = [
  urlField("url", {
    message: withGuide(
      "Enter the Minecraft QueQiao WebSocket URL.",
      "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
    ),
    placeholder: "ws://127.0.0.1:8080",
    required: true,
  }),
  textField("selfId", {
    message:
      "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
    placeholder: "minecraft",
  }),
  textField("serverName", {
    message:
      "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
    placeholder: "Survival",
  }),
  textField("token", {
    message:
      "Enter the QueQiao access token if required. Leave blank otherwise.",
    placeholder: "optional token",
  }),
];

const CHAT_BRIDGE_ADAPTER_PROMPTS: Record<
  ChatBridgeBuiltInAdapterKey,
  ChatBridgeAdapterPromptHandler
> = {
  telegram: createPromptHandler({
    fields: TELEGRAM_PROMPT_FIELDS,
    detail: () =>
      "Chat bridge mode: polling · token saved to target settings.json",
    config: ({ token }) => ({
      telegram: { token, protocol: "polling", slash: true },
    }),
  }),
  onebot: createPromptHandler({
    fields: ONEBOT_PROMPT_FIELDS,
    detail: ({ endpoint }) => {
      const protocol = getEndpointProtocol(endpoint);
      return `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`;
    },
    config: ({ endpoint, selfId, token }) => {
      const protocol = getEndpointProtocol(endpoint);
      return {
        onebot: compactObject({
          endpoint,
          protocol,
          selfId,
          token,
        }),
      };
    },
  }),
  qq: createPromptHandler({
    fields: QQ_PROMPT_FIELDS,
    detail: () =>
      "Chat bridge mode: websocket · app credentials saved to target settings.json",
    config: ({ id, secret, token, type }) => ({
      qq: { id, secret, token, type, protocol: "websocket" },
    }),
  }),
  lark: createPromptHandler({
    fields: LARK_PROMPT_FIELDS,
    detail: ({ platform }) =>
      `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
    config: ({ platform, appId, appSecret }) => ({
      lark: {
        platform,
        protocol: "ws",
        appId,
        appSecret,
      },
    }),
  }),
  discord: createPromptHandler({
    fields: DISCORD_PROMPT_FIELDS,
    detail: () => "Chat bridge token: [saved to target settings.json]",
    config: ({ token }) => ({ discord: { token } }),
  }),
  slack: createPromptHandler({
    fields: SLACK_PROMPT_FIELDS,
    detail: () => "Chat bridge mode: ws",
    config: ({ token, botToken }) => ({
      slack: {
        protocol: "ws",
        token,
        botToken,
      },
    }),
  }),
  minecraft: createPromptHandler({
    fields: MINECRAFT_PROMPT_FIELDS,
    detail: ({ url }) => `Chat bridge mode: ws · endpoint: ${url}`,
    config: ({ url, selfId, serverName, token }) => ({
      minecraft: compactObject({
        protocol: "ws",
        url,
        selfId,
        serverName,
        token,
      }),
    }),
  }),
};

async function promptChatBridgeAdapterConfig(
  prompt: ChatBridgePromptApi,
  adapterKey: ChatBridgeBuiltInAdapterKey,
) {
  const promptAdapter = CHAT_BRIDGE_ADAPTER_PROMPTS[adapterKey];
  if (!promptAdapter) {
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);
  }
  return await promptAdapter(prompt);
}

export async function promptChatBridgeSetup(
  prompt: ChatBridgePromptApi,
  options: { confirmEnable?: boolean } = {},
) {
  const shouldConfirmEnable = options.confirmEnable !== false;
  const enableChatBridge = shouldConfirmEnable
    ? prompt.ensureNotCancelled(
        await prompt.confirm({
          message: "Configure a chat bridge now?",
          initialValue: false,
        }),
      )
    : true;

  let chatDescription = "disabled for now";
  let chatDetail = "";
  let chatConfig: any = null;
  let adapterKey = "";
  if (!enableChatBridge) {
    return { adapterKey, chatDescription, chatDetail, chatConfig };
  }

  adapterKey = await promptSelectValue(prompt, {
    message: "Choose a chat platform.",
    values: listChatBridgeAdapterPromptOptions(),
  });
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  if (!adapterSpec)
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);

  chatDescription = adapterSpec.label;
  const configured = await promptChatBridgeAdapterConfig(
    prompt,
    adapterSpec.key,
  );
  chatDetail = configured.detail;
  chatConfig = configured.config;

  return {
    adapterKey,
    chatDescription,
    chatDetail,
    chatConfig,
  } as ChatBridgeSetupResult;
}
