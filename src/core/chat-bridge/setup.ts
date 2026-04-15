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
  koishiDescription: string;
  koishiDetail: string;
  koishiConfig: any;
};

type MailPreset = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
};

const MAIL_PRESETS: Record<string, MailPreset> = {
  qq: {
    imapHost: "imap.qq.com",
    imapPort: 993,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpTls: true,
  },
  "163": {
    imapHost: "imap.163.com",
    imapPort: 993,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpTls: true,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    smtpTls: true,
  },
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpTls: true,
  },
};

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function withGuide(message: string, guide?: string) {
  const main = safeString(message).trim();
  const extra = safeString(guide).trim();
  return extra ? `${main}\nWhere to find it: ${extra}` : main;
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

async function promptRequiredNumber(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: number;
    min?: number;
    max?: number;
  },
) {
  const raw = await promptText(prompt, {
    message: options.message,
    placeholder: options.placeholder,
    defaultValue:
      options.defaultValue === undefined ? undefined : String(options.defaultValue),
    required: true,
    validate(value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) return "Use an integer.";
      if (options.min !== undefined && parsed < options.min)
        return `Use a value >= ${options.min}.`;
      if (options.max !== undefined && parsed > options.max)
        return `Use a value <= ${options.max}.`;
    },
  });
  return Number(raw);
}

async function promptBoolean(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    initialValue?: boolean;
  },
) {
  return Boolean(
    prompt.ensureNotCancelled(
      await prompt.confirm({
        message: options.message,
        initialValue: options.initialValue,
      }),
    ),
  );
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
    if (item === undefined) continue;
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
    ),
    placeholder: "ws://127.0.0.1:3001",
    required: true,
  });
  const protocol = /^https?:\/\//i.test(String(endpoint || "")) ? "http" : "ws";
  const selfId = await promptOptionalText(prompt, {
    message: withGuide(
      "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
      "Usually the bot QQ number from your OneBot client or bridge config.",
    ),
    placeholder: "123456789",
  });
  const token = await promptOptionalText(prompt, {
    message: withGuide(
      "Enter the OneBot access token if required. Leave blank otherwise.",
      "Use the access token from your OneBot server config only if you enabled one.",
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
    ),
    placeholder: "Bot token",
    required: true,
  });
  return {
    detail: "Chat bridge token: [saved to target settings.json]",
    config: { discord: { token } },
  };
}

async function promptKookConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the Kook bot token.",
      "Kook developer console → your bot application → Bot token.",
    ),
    placeholder: "Bot token",
    required: true,
  });
  return {
    detail: "Chat bridge mode: ws · token saved to target settings.json",
    config: {
      kook: {
        protocol: "ws",
        token,
      },
    },
  };
}

async function promptQQConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot app ID.",
      "QQ Open Platform → your bot application → app credentials.",
    ),
    placeholder: "App ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot secret.",
      "QQ Open Platform → your bot application → app credentials.",
    ),
    placeholder: "Secret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the QQ bot token.",
      "QQ Open Platform → your bot application → bot token.",
    ),
    placeholder: "Token",
    required: true,
  });
  const type = await promptSelectValue(prompt, {
    message: withGuide(
      "Choose the QQ bot scope.",
      "Use the bot type shown in your QQ bot application settings.",
    ),
    values: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
  });
  return {
    detail: "Chat bridge mode: websocket · app credentials saved to target settings.json",
    config: { qq: { id, secret, token, type, protocol: "websocket" } },
  };
}

async function promptLarkConfig(prompt: ChatBridgePromptApi) {
  const platform = await promptSelectValue(prompt, {
    message: withGuide(
      "Choose the Lark / Feishu region.",
      "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
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
    ),
    placeholder: "App ID",
    required: true,
  });
  const appSecret = await promptText(prompt, {
    message: withGuide(
      "Enter the Lark / Feishu app secret.",
      "Developer console → your app → Credentials / Basic information.",
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

async function promptMailConfig(prompt: ChatBridgePromptApi) {
  const preset = await promptSelectValue(prompt, {
    message: withGuide(
      "Choose a mail service preset.",
      "Use your provider preset if possible. Choose Custom only when your provider is not listed.",
    ),
    values: [
      { value: "custom", label: "Custom" },
      { value: "qq", label: "QQ Mail" },
      { value: "163", label: "Netease 163" },
      { value: "outlook", label: "Outlook" },
      { value: "gmail", label: "Gmail" },
    ],
  });
  const username = await promptText(prompt, {
    message: withGuide(
      "Enter the mail username.",
      "Usually the full mailbox address used for IMAP / SMTP login.",
    ),
    placeholder: "bot@example.com",
    required: true,
  });
  const password = await promptText(prompt, {
    message: withGuide(
      "Enter the mail password or authorization code.",
      "Use the provider's SMTP / IMAP authorization code when the mailbox requires one.",
    ),
    placeholder: "Authorization code",
    required: true,
  });

  const presetConfig = preset === "custom" ? undefined : MAIL_PRESETS[preset];
  const imapHost =
    preset === "custom"
      ? await promptText(prompt, {
          message: withGuide(
            "Enter the IMAP host.",
            "Your mail provider's IMAP settings page.",
          ),
          placeholder: "imap.example.com",
          required: true,
        })
      : presetConfig!.imapHost;
  const imapPort =
    preset === "custom"
      ? await promptRequiredNumber(prompt, {
          message: "Enter the IMAP port.",
          placeholder: "993",
          defaultValue: 993,
          min: 1,
          max: 65535,
        })
      : presetConfig!.imapPort;
  const imapTls =
    preset === "custom"
      ? await promptBoolean(prompt, {
          message: "Enable IMAP TLS?",
          initialValue: true,
        })
      : true;
  const smtpHost =
    preset === "custom"
      ? await promptText(prompt, {
          message: withGuide(
            "Enter the SMTP host.",
            "Your mail provider's SMTP settings page.",
          ),
          placeholder: "smtp.example.com",
          required: true,
        })
      : presetConfig!.smtpHost;
  const smtpPort =
    preset === "custom"
      ? await promptRequiredNumber(prompt, {
          message: "Enter the SMTP port.",
          placeholder: "465",
          defaultValue: 465,
          min: 1,
          max: 65535,
        })
      : presetConfig!.smtpPort;
  const smtpTls =
    preset === "custom"
      ? await promptBoolean(prompt, {
          message: "Enable SMTP TLS?",
          initialValue: true,
        })
      : presetConfig!.smtpTls;

  return {
    detail: `Chat bridge mail preset: ${preset}`,
    config: {
      mail: {
        username,
        password,
        imap: { host: imapHost, port: imapPort, tls: imapTls },
        smtp: { host: smtpHost, port: smtpPort, tls: smtpTls },
      },
    },
  };
}

async function promptWeChatOfficialConfig(prompt: ChatBridgePromptApi) {
  const account = await promptText(prompt, {
    message: withGuide(
      "Enter the WeChat Official account original ID.",
      "WeChat Official Account admin → Settings / Account information.",
    ),
    placeholder: "Original ID",
    required: true,
  });
  const appId = await promptText(prompt, {
    message: withGuide(
      "Enter the WeChat Official AppID.",
      "WeChat Official Account platform → Development → Basic configuration.",
    ),
    placeholder: "AppID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the WeChat Official AppSecret.",
      "WeChat Official Account platform → Development → Basic configuration.",
    ),
    placeholder: "AppSecret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the WeChat Official webhook token.",
      "WeChat Official Account platform → Development → Basic configuration → Token.",
    ),
    placeholder: "Webhook Token",
    required: true,
  });
  const aesKey = await promptText(prompt, {
    message: withGuide(
      "Enter the WeChat Official EncodingAESKey.",
      "WeChat Official Account platform → Development → Basic configuration → EncodingAESKey.",
    ),
    placeholder: "EncodingAESKey",
    required: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: {
      "wechat-official": { account, appId, secret, token, aesKey, customerService: false },
    },
  };
}

async function promptWeComConfig(prompt: ChatBridgePromptApi) {
  const corpId = await promptText(prompt, {
    message: withGuide(
      "Enter the WeCom corp ID.",
      "WeCom admin console → My Company / Enterprise information.",
    ),
    placeholder: "Corp ID",
    required: true,
  });
  const agentId = await promptText(prompt, {
    message: withGuide(
      "Enter the WeCom agent ID.",
      "WeCom admin console → Applications → your app → AgentId.",
    ),
    placeholder: "Agent ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the WeCom app secret.",
      "WeCom admin console → Applications → your app → Secret.",
    ),
    placeholder: "AppSecret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the WeCom webhook token.",
      "WeCom admin console → Applications → your app → Receive messages.",
    ),
    placeholder: "Webhook Token",
    required: true,
  });
  const aesKey = await promptText(prompt, {
    message: withGuide(
      "Enter the WeCom EncodingAESKey.",
      "WeCom admin console → Applications → your app → Receive messages.",
    ),
    placeholder: "EncodingAESKey",
    required: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: { wecom: { corpId, agentId, secret, token, aesKey } },
  };
}

async function promptDingTalkConfig(prompt: ChatBridgePromptApi) {
  const appkey = await promptText(prompt, {
    message: withGuide(
      "Enter the DingTalk AppKey.",
      "DingTalk developer console → your application → credentials.",
    ),
    placeholder: "AppKey",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the DingTalk secret.",
      "DingTalk developer console → your application → credentials.",
    ),
    placeholder: "Secret",
    required: true,
  });
  const agentId = await promptOptionalText(prompt, {
    message: withGuide(
      "Enter the DingTalk AgentId if you have one. Leave blank to skip.",
      "DingTalk developer console → your application → basic information.",
    ),
    placeholder: "AgentId",
  });
  return {
    detail: "Chat bridge mode: ws",
    config: { dingtalk: compactObject({ protocol: "ws", appkey, secret, agentId }) },
  };
}

async function promptMatrixConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: withGuide(
      "Enter the Matrix bot ID localpart.",
      "Your Matrix application service registration file or bot account setup.",
    ),
    placeholder: "rin-bot",
    required: true,
  });
  const host = await promptText(prompt, {
    message: withGuide(
      "Enter the Matrix homeserver host.",
      "Your Matrix homeserver address, for example matrix.example.com.",
    ),
    placeholder: "matrix.example.com",
    required: true,
  });
  const hsToken = await promptText(prompt, {
    message: withGuide(
      "Enter the Matrix hs_token.",
      "Your Matrix application service registration file.",
    ),
    placeholder: "hs_token",
    required: true,
  });
  const asToken = await promptText(prompt, {
    message: withGuide(
      "Enter the Matrix as_token.",
      "Your Matrix application service registration file.",
    ),
    placeholder: "as_token",
    required: true,
  });
  return {
    detail: "Chat bridge homeserver credentials: [saved to target settings.json]",
    config: {
      matrix: { id, host, hsToken, asToken },
    },
  };
}

async function promptWhatsAppConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: withGuide(
      "Enter the WhatsApp business ID.",
      "Meta for Developers → WhatsApp → API Setup / WhatsApp Business Account ID.",
    ),
    placeholder: "Business ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the WhatsApp app secret.",
      "Meta for Developers → App settings → Basic → App Secret.",
    ),
    placeholder: "App Secret",
    required: true,
  });
  const systemToken = await promptText(prompt, {
    message: withGuide(
      "Enter the WhatsApp system user access token.",
      "Meta for Developers → WhatsApp → API Setup → permanent or system user token.",
    ),
    placeholder: "System Token",
    required: true,
  });
  const verifyToken = await promptText(prompt, {
    message: withGuide(
      "Enter the WhatsApp webhook verify token.",
      "The verify token you set in Meta webhook settings for this app.",
    ),
    placeholder: "Verify Token",
    required: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: { whatsapp: { id, secret, systemToken, verifyToken } },
  };
}

async function promptLineConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the LINE channel access token.",
      "LINE Developers console → your Messaging API channel → Channel access token.",
    ),
    placeholder: "Channel access token",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: withGuide(
      "Enter the LINE channel secret.",
      "LINE Developers console → your channel → Basic settings.",
    ),
    placeholder: "Channel secret",
    required: true,
  });
  return {
    detail: "Chat bridge token and secret: [saved to target settings.json]",
    config: { line: { token, secret } },
  };
}

async function promptSlackConfig(prompt: ChatBridgePromptApi) {
  const token = await promptText(prompt, {
    message: withGuide(
      "Enter the Slack app-level token.",
      "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
    ),
    placeholder: "xapp-...",
    required: true,
  });
  const botToken = await promptText(prompt, {
    message: withGuide(
      "Enter the Slack bot token.",
      "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
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

async function promptZulipConfig(prompt: ChatBridgePromptApi) {
  const email = await promptText(prompt, {
    message: withGuide(
      "Enter the Zulip bot email.",
      "Zulip bot account details or the bot creation page.",
    ),
    placeholder: "bot@example.com",
    required: true,
  });
  const key = await promptText(prompt, {
    message: withGuide(
      "Enter the Zulip bot API key.",
      "Zulip bot account → API key or Personal settings → Account & privacy → API key.",
    ),
    placeholder: "API key",
    required: true,
  });
  return {
    detail: "Chat bridge bot credentials: [saved to target settings.json]",
    config: { zulip: { email, key } },
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
    case "discord":
      return await promptDiscordConfig(prompt);
    case "kook":
      return await promptKookConfig(prompt);
    case "qq":
      return await promptQQConfig(prompt);
    case "lark":
      return await promptLarkConfig(prompt);
    case "mail":
      return await promptMailConfig(prompt);
    case "wechat-official":
      return await promptWeChatOfficialConfig(prompt);
    case "wecom":
      return await promptWeComConfig(prompt);
    case "dingtalk":
      return await promptDingTalkConfig(prompt);
    case "matrix":
      return await promptMatrixConfig(prompt);
    case "whatsapp":
      return await promptWhatsAppConfig(prompt);
    case "line":
      return await promptLineConfig(prompt);
    case "slack":
      return await promptSlackConfig(prompt);
    case "zulip":
      return await promptZulipConfig(prompt);
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

  let koishiDescription = "disabled for now";
  let koishiDetail = "";
  let koishiConfig: any = null;
  let adapterKey = "";
  if (!enableChatBridge) {
    return { adapterKey, koishiDescription, koishiDetail, koishiConfig };
  }

  adapterKey = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose a chat platform.",
        options: listChatBridgeAdapterSpecs().map((item) => ({
          value: item.key,
          label: item.label,
          hint: "guided setup",
        })),
      }),
    ),
  ).trim();
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  if (!adapterSpec) throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);

  koishiDescription = adapterSpec.label;
  const configured = await promptChatBridgeAdapterConfig(prompt, adapterKey);
  koishiDetail = configured.detail;
  koishiConfig = configured.config;

  return { adapterKey, koishiDescription, koishiDetail, koishiConfig } as ChatBridgeSetupResult;
}
