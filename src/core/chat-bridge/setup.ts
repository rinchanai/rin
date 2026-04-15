import {
  getChatBridgeAdapterSpec,
  listChatBridgeAdapterSpecs,
} from "./adapters.js";

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

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

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

async function promptOptionalText(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | void;
  },
) {
  const value = await promptText(prompt, {
    ...options,
    required: false,
    validate(value) {
      if (!value) return;
      return options.validate?.(value);
    },
  });
  return value || undefined;
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

async function promptUrl(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
  },
) {
  const value = await promptText(prompt, {
    ...options,
    required: options.required,
    validate(value) {
      if (!value && !options.required) return;
      try {
        new URL(value);
      } catch {
        return "Use a valid URL.";
      }
    },
  });
  return value || undefined;
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

async function promptTelegramConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the Telegram bot token.",
      "Telegram @BotFather → choose your bot → API token.",
      "https://t.me/BotFather",
    ),
    placeholder: "123456:ABCDEF...",
    required: true,
  });
  return {
    detail: "Chat bridge mode: polling · token saved to target settings.json",
    config: { telegram: { token, protocol: "polling", slash: true } },
  };
}

async function promptOneBotConfig(prompt: ChatBridgePromptApi) {
  const endpoint = await promptUrl(prompt, {
    message: withGuide(
      "Enter the OneBot endpoint URL.",
      "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
      "https://11.onebot.dev/",
    ),
    placeholder: "ws://127.0.0.1:3001",
    required: true,
  });
  const protocol = /^https?:\/\//i.test(String(endpoint || "")) ? "http" : "ws";
  const selfId = await promptOptionalText(prompt, {
    message: withGuide(
      "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
      "Usually the bot QQ number from your OneBot client or bridge config.",
      "https://11.onebot.dev/",
    ),
    placeholder: "123456789",
  });
  const token = await promptOptionalText(prompt, {
    message: withGuide(
      "Enter the OneBot access token if required. Leave blank otherwise.",
      "Use the access token from your OneBot server config only if you enabled one.",
      "https://11.onebot.dev/",
    ),
    placeholder: "optional token",
  });
  return {
    detail: `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`,
    config: {
      onebot: compactObject({
        endpoint,
        protocol,
        selfId,
        token,
      }),
    },
  };
}

async function promptDiscordConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the Discord bot token.",
      "Discord Developer Portal → your application → Bot → Reset Token / Token.",
      "https://discord.com/developers/applications",
    ),
    placeholder: "Bot token",
    required: true,
  });
  return {
    detail: "Chat bridge token: [saved to target settings.json]",
    config: { discord: { token } },
  };
}

async function promptQQConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot app ID.",
      "QQ bot developer docs → create your bot application → app credentials.",
      "https://bot.q.qq.com/wiki/develop/api-v2/",
    ),
    placeholder: "App ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot secret.",
      "QQ bot developer docs → create your bot application → app credentials.",
      "https://bot.q.qq.com/wiki/develop/api-v2/",
    ),
    placeholder: "Secret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot token.",
      "QQ bot developer docs → your bot application → token / credentials.",
      "https://bot.q.qq.com/wiki/develop/api-v2/",
    ),
    placeholder: "Token",
    required: true,
  });
  const type = await promptSelectValue(prompt, {
    message: withGuide(
      "Choose the QQ bot scope.",
      "Use the bot type shown in your QQ bot application settings.",
      "https://bot.q.qq.com/wiki/develop/api-v2/",
    ),
    values: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
  });
  return {
    detail:
      "Chat bridge mode: websocket · app credentials saved to target settings.json",
    config: { qq: { id, secret, token, type, protocol: "websocket" } },
  };
}

async function promptLarkConfig(prompt: ChatBridgePromptApi) {
  const platform = await promptSelectValue(prompt, {
    message: withGuide(
      "Choose the Lark / Feishu region.",
      "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
      [
        "Feishu https://open.feishu.cn/app?lang=zh-CN",
        "Lark https://open.larksuite.com/",
      ],
    ),
    values: [
      { value: "feishu", label: "Feishu", hint: "China / open.feishu.cn" },
      { value: "lark", label: "Lark", hint: "Global / open.larksuite.com" },
    ],
  });
  const appId = await promptText(prompt, {
    message: withGuide(
      "Enter the Lark / Feishu app ID.",
      "Developer console → your app → Credentials / Basic information.",
      [
        "Feishu https://open.feishu.cn/app?lang=zh-CN",
        "Lark https://open.larksuite.com/",
      ],
    ),
    placeholder: "App ID",
    required: true,
  });
  const appSecret = await promptText(prompt, {
    message: withGuide(
      "Enter the Lark / Feishu app secret.",
      "Developer console → your app → Credentials / Basic information.",
      [
        "Feishu https://open.feishu.cn/app?lang=zh-CN",
        "Lark https://open.larksuite.com/",
      ],
    ),
    placeholder: "App secret",
    required: true,
  });
  return {
    detail: `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
    config: {
      lark: {
        platform,
        protocol: "ws",
        appId,
        appSecret,
      },
    },
  };
}

async function promptSlackConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the Slack app-level token.",
      "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
      "https://api.slack.com/apps",
    ),
    placeholder: "xapp-...",
    required: true,
  });
  const botToken = await promptText(prompt, {
    message: withGuide(
      "Enter the Slack bot token.",
      "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
      "https://api.slack.com/apps",
    ),
    placeholder: "xoxb-...",
    required: true,
  });
  return {
    detail: "Chat bridge mode: ws",
    config: {
      slack: {
        protocol: "ws",
        token,
        botToken,
      },
    },
  };
}

async function promptMinecraftConfig(prompt: ChatBridgePromptApi) {
  const url = await promptUrl(prompt, {
    message: withGuide(
      "Enter the Minecraft QueQiao WebSocket URL.",
      "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
    ),
    placeholder: "ws://127.0.0.1:8080",
    required: true,
  });
  const selfId = await promptOptionalText(prompt, {
    message:
      "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
    placeholder: "minecraft",
  });
  const serverName = await promptOptionalText(prompt, {
    message:
      "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
    placeholder: "Survival",
  });
  const token = await promptOptionalText(prompt, {
    message:
      "Enter the QueQiao access token if required. Leave blank otherwise.",
    placeholder: "optional token",
  });
  return {
    detail: `Chat bridge mode: ws · endpoint: ${url}`,
    config: {
      minecraft: compactObject({
        protocol: "ws",
        url,
        selfId,
        serverName,
        token,
      }),
    },
  };
}

async function promptChatBridgeAdapterConfig(
  prompt: ChatBridgePromptApi,
  adapterKey: string,
) {
  switch (adapterKey) {
    case "telegram":
      return await promptTelegramConfig(prompt);
    case "onebot":
      return await promptOneBotConfig(prompt);
    case "qq":
      return await promptQQConfig(prompt);
    case "lark":
      return await promptLarkConfig(prompt);
    case "discord":
      return await promptDiscordConfig(prompt);
    case "slack":
      return await promptSlackConfig(prompt);
    case "minecraft":
      return await promptMinecraftConfig(prompt);
    default:
      throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);
  }
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

  adapterKey = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose a chat platform.",
        options: listChatBridgeAdapterSpecs().map((item) => ({
          value: item.key,
          label: item.label,
          hint:
            item.key === "telegram"
              ? "bot token"
              : item.key === "onebot"
                ? "endpoint + protocol"
                : item.key === "slack"
                  ? "app token + bot token"
                  : "guided setup",
        })),
      }),
    ),
  ).trim();
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  if (!adapterSpec)
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);

  chatDescription = adapterSpec.label;
  const configured = await promptChatBridgeAdapterConfig(prompt, adapterKey);
  chatDetail = configured.detail;
  chatConfig = configured.config;

  return {
    adapterKey,
    chatDescription,
    chatDetail,
    chatConfig,
  } as ChatBridgeSetupResult;
}
