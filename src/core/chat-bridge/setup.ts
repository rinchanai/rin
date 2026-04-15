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
    message: "Enter the Telegram bot token.",
    placeholder: "123456:ABCDEF...",
    required: true,
  });
  const slash = await promptBoolean(prompt, {
    message: "Enable Telegram slash command sync?",
    initialValue: true,
  });
  return {
    detail: "Chat bridge token: [saved to target settings.json]",
    config: { telegram: { token, protocol: "polling", slash } },
  };
}

async function promptOneBotConfig(prompt: ChatBridgePromptApi) {
  const endpoint = await promptUrl(prompt, {
    message: "Enter the OneBot endpoint URL.",
    placeholder: "ws://127.0.0.1:3001",
    required: true,
  });
  const protocol = await promptSelectValue(prompt, {
    message: "Choose the OneBot protocol.",
    values: [
      { value: "ws", label: "WebSocket", hint: "recommended" },
      { value: "http", label: "HTTP" },
    ],
  });
  const selfId = await promptOptionalText(prompt, {
    message: "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
    placeholder: "123456789",
  });
  const token = await promptOptionalText(prompt, {
    message: "Enter the OneBot access token if required. Leave blank otherwise.",
    placeholder: "optional token",
  });
  return {
    detail: `Chat bridge endpoint: ${endpoint}`,
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
    message: "Enter the Discord bot token.",
    placeholder: "Bot token",
    required: true,
  });
  return {
    detail: "Chat bridge token: [saved to target settings.json]",
    config: { discord: { token } },
  };
}

async function promptKookConfig(prompt: ChatBridgePromptApi) {
  const protocol = await promptSelectValue(prompt, {
    message: "Choose the Kook connection mode.",
    values: [
      { value: "ws", label: "WebSocket", hint: "token only" },
      { value: "http", label: "Webhook / HTTP", hint: "token + verify token" },
    ],
  });
  const token = await promptText(prompt, {
    message: "Enter the Kook bot token.",
    placeholder: "Bot token",
    required: true,
  });
  const verifyToken =
    protocol === "http"
      ? await promptText(prompt, {
          message: "Enter the Kook verify token.",
          placeholder: "verify token",
          required: true,
        })
      : undefined;
  const path =
    protocol === "http"
      ? await promptText(prompt, {
          message: "Choose the Kook webhook path.",
          placeholder: "/kook",
          defaultValue: "/kook",
          required: true,
        })
      : undefined;
  return {
    detail: `Chat bridge mode: ${protocol}`,
    config: {
      kook: compactObject({
        protocol,
        token,
        verifyToken,
        path,
      }),
    },
  };
}

async function promptQQConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: "Enter the QQ bot app ID.",
    placeholder: "App ID",
    required: true,
  });
  const key = await promptText(prompt, {
    message: "Enter the QQ bot secret.",
    placeholder: "Secret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: "Enter the QQ bot token.",
    placeholder: "Token",
    required: true,
  });
  const type = await promptSelectValue(prompt, {
    message: "Choose the QQ bot scope.",
    values: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
    ],
  });
  const sandbox = await promptBoolean(prompt, {
    message: "Enable QQ sandbox mode?",
    initialValue: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: { qq: { id, key, token, type, sandbox } },
  };
}

async function promptLarkConfig(prompt: ChatBridgePromptApi) {
  const appId = await promptText(prompt, {
    message: "Enter the Lark / Feishu app ID.",
    placeholder: "App ID",
    required: true,
  });
  const appSecret = await promptText(prompt, {
    message: "Enter the Lark / Feishu app secret.",
    placeholder: "App secret",
    required: true,
  });
  const encryptKey = await promptText(prompt, {
    message: "Enter the Lark / Feishu encrypt key.",
    placeholder: "Encrypt Key",
    required: true,
  });
  const verificationToken = await promptText(prompt, {
    message: "Enter the Lark / Feishu verification token.",
    placeholder: "Verification Token",
    required: true,
  });
  const path = await promptText(prompt, {
    message: "Choose the webhook path.",
    placeholder: "/lark",
    defaultValue: "/lark",
    required: true,
  });
  const selfUrl = await promptOptionalText(prompt, {
    message: "Enter selfUrl if this adapter should override the global public URL. Leave blank to use the default.",
    placeholder: "https://example.com",
    validate(value) {
      try {
        new URL(value);
      } catch {
        return "Use a valid URL.";
      }
    },
  });
  const verifyToken = await promptBoolean(prompt, {
    message: "Verify Lark webhook tokens?",
    initialValue: true,
  });
  const verifySignature = await promptBoolean(prompt, {
    message: "Verify Lark webhook signatures?",
    initialValue: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: {
      lark: compactObject({
        appId,
        appSecret,
        encryptKey,
        verificationToken,
        path,
        selfUrl,
        verifyToken,
        verifySignature,
      }),
    },
  };
}

async function promptMailConfig(prompt: ChatBridgePromptApi) {
  const preset = await promptSelectValue(prompt, {
    message: "Choose a mail service preset.",
    values: [
      { value: "custom", label: "Custom" },
      { value: "qq", label: "QQ Mail" },
      { value: "163", label: "Netease 163" },
      { value: "outlook", label: "Outlook" },
      { value: "gmail", label: "Gmail" },
    ],
  });
  const username = await promptText(prompt, {
    message: "Enter the mail username.",
    placeholder: "bot@example.com",
    required: true,
  });
  const password = await promptText(prompt, {
    message: "Enter the mail password or authorization code.",
    placeholder: "Authorization code",
    required: true,
  });
  const selfId = await promptText(prompt, {
    message: "Enter the sender mail address.",
    placeholder: username,
    defaultValue: username,
    required: true,
  });
  const subject = await promptOptionalText(prompt, {
    message: "Enter the default mail subject. Leave blank if you do not want a fixed subject.",
    placeholder: "optional subject",
  });

  const presetConfig = preset === "custom" ? undefined : MAIL_PRESETS[preset];
  const imapHost = await promptText(prompt, {
    message: "Enter the IMAP host.",
    placeholder: presetConfig?.imapHost || "imap.example.com",
    defaultValue: presetConfig?.imapHost,
    required: true,
  });
  const imapPort = await promptRequiredNumber(prompt, {
    message: "Enter the IMAP port.",
    placeholder: String(presetConfig?.imapPort || 993),
    defaultValue: presetConfig?.imapPort || 993,
    min: 1,
    max: 65535,
  });
  const imapTls = await promptBoolean(prompt, {
    message: "Enable IMAP TLS?",
    initialValue: true,
  });
  const smtpHost = await promptText(prompt, {
    message: "Enter the SMTP host.",
    placeholder: presetConfig?.smtpHost || "smtp.example.com",
    defaultValue: presetConfig?.smtpHost,
    required: true,
  });
  const smtpPort = await promptRequiredNumber(prompt, {
    message: "Enter the SMTP port.",
    placeholder: String(presetConfig?.smtpPort || 465),
    defaultValue: presetConfig?.smtpPort || 465,
    min: 1,
    max: 65535,
  });
  const smtpTls = await promptBoolean(prompt, {
    message: "Enable SMTP TLS?",
    initialValue: presetConfig?.smtpTls ?? true,
  });

  return {
    detail: "Chat bridge mail credentials: [saved to target settings.json]",
    config: {
      mail: compactObject({
        username,
        password,
        selfId,
        subject,
        imap: { host: imapHost, port: imapPort, tls: imapTls },
        smtp: { host: smtpHost, port: smtpPort, tls: smtpTls },
      }),
    },
  };
}

async function promptWeChatOfficialConfig(prompt: ChatBridgePromptApi) {
  const account = await promptText(prompt, {
    message: "Enter the WeChat Official account original ID.",
    placeholder: "Original ID",
    required: true,
  });
  const appId = await promptText(prompt, {
    message: "Enter the WeChat Official AppID.",
    placeholder: "AppID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: "Enter the WeChat Official AppSecret.",
    placeholder: "AppSecret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: "Enter the WeChat Official webhook token.",
    placeholder: "Webhook Token",
    required: true,
  });
  const aesKey = await promptText(prompt, {
    message: "Enter the WeChat Official EncodingAESKey.",
    placeholder: "EncodingAESKey",
    required: true,
  });
  const customerService = await promptBoolean(prompt, {
    message: "Enable WeChat customer service mode?",
    initialValue: false,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: {
      "wechat-official": { account, appId, secret, token, aesKey, customerService },
    },
  };
}

async function promptWeComConfig(prompt: ChatBridgePromptApi) {
  const corpId = await promptText(prompt, {
    message: "Enter the WeCom corp ID.",
    placeholder: "Corp ID",
    required: true,
  });
  const agentId = await promptText(prompt, {
    message: "Enter the WeCom agent ID.",
    placeholder: "Agent ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: "Enter the WeCom app secret.",
    placeholder: "AppSecret",
    required: true,
  });
  const token = await promptText(prompt, {
    message: "Enter the WeCom webhook token.",
    placeholder: "Webhook Token",
    required: true,
  });
  const aesKey = await promptText(prompt, {
    message: "Enter the WeCom EncodingAESKey.",
    placeholder: "EncodingAESKey",
    required: true,
  });
  return {
    detail: "Chat bridge app credentials: [saved to target settings.json]",
    config: { wecom: { corpId, agentId, secret, token, aesKey } },
  };
}

async function promptDingTalkConfig(prompt: ChatBridgePromptApi) {
  const protocol = await promptSelectValue(prompt, {
    message: "Choose the DingTalk connection mode.",
    values: [
      { value: "ws", label: "Stream / WebSocket" },
      { value: "http", label: "HTTP callback" },
    ],
  });
  const appkey = await promptText(prompt, {
    message: "Enter the DingTalk AppKey.",
    placeholder: "AppKey",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: "Enter the DingTalk secret.",
    placeholder: "Secret",
    required: true,
  });
  const agentId = await promptText(prompt, {
    message: "Enter the DingTalk AgentId.",
    placeholder: "AgentId",
    required: true,
  });
  return {
    detail: `Chat bridge mode: ${protocol}`,
    config: { dingtalk: { protocol, appkey, secret, agentId } },
  };
}

async function promptMatrixConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: "Enter the Matrix bot ID localpart.",
    placeholder: "rin-bot",
    required: true,
  });
  const host = await promptText(prompt, {
    message: "Enter the Matrix homeserver host.",
    placeholder: "matrix.example.com",
    required: true,
  });
  const hsToken = await promptText(prompt, {
    message: "Enter the Matrix hs_token.",
    placeholder: "hs_token",
    required: true,
  });
  const asToken = await promptText(prompt, {
    message: "Enter the Matrix as_token.",
    placeholder: "as_token",
    required: true,
  });
  const endpoint = await promptOptionalText(prompt, {
    message: "Enter the Matrix endpoint override if needed. Leave blank to use https://{host}.",
    placeholder: "https://matrix.example.com",
    validate(value) {
      try {
        new URL(value);
      } catch {
        return "Use a valid URL.";
      }
    },
  });
  const name = await promptOptionalText(prompt, {
    message: "Enter the Matrix display name if you want Koishi to set it at startup. Leave blank to skip.",
    placeholder: "optional display name",
  });
  const avatar = await promptOptionalText(prompt, {
    message: "Enter the Matrix avatar URL if you want Koishi to set it at startup. Leave blank to skip.",
    placeholder: "https://example.com/avatar.png",
    validate(value) {
      try {
        new URL(value);
      } catch {
        return "Use a valid URL.";
      }
    },
  });
  return {
    detail: "Chat bridge homeserver credentials: [saved to target settings.json]",
    config: {
      matrix: compactObject({ id, host, hsToken, asToken, endpoint, name, avatar }),
    },
  };
}

async function promptWhatsAppConfig(prompt: ChatBridgePromptApi) {
  const id = await promptText(prompt, {
    message: "Enter the WhatsApp business ID.",
    placeholder: "Business ID",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: "Enter the WhatsApp app secret.",
    placeholder: "App Secret",
    required: true,
  });
  const systemToken = await promptText(prompt, {
    message: "Enter the WhatsApp system user access token.",
    placeholder: "System Token",
    required: true,
  });
  const verifyToken = await promptText(prompt, {
    message: "Enter the WhatsApp webhook verify token.",
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
    message: "Enter the LINE channel access token.",
    placeholder: "Channel access token",
    required: true,
  });
  const secret = await promptText(prompt, {
    message: "Enter the LINE channel secret.",
    placeholder: "Channel secret",
    required: true,
  });
  return {
    detail: "Chat bridge token and secret: [saved to target settings.json]",
    config: { line: { token, secret } },
  };
}

async function promptSlackConfig(prompt: ChatBridgePromptApi) {
  const protocol = await promptSelectValue(prompt, {
    message: "Choose the Slack connection mode.",
    values: [
      { value: "ws", label: "Socket Mode / WebSocket", hint: "recommended" },
      { value: "http", label: "HTTP callback" },
    ],
  });
  const token = await promptText(prompt, {
    message: "Enter the Slack app-level token.",
    placeholder: "xapp-...",
    required: true,
  });
  const botToken = await promptText(prompt, {
    message: "Enter the Slack bot token.",
    placeholder: "xoxb-...",
    required: true,
  });
  const signing =
    protocol === "http"
      ? await promptText(prompt, {
          message: "Enter the Slack signing secret.",
          placeholder: "Signing Secret",
          required: true,
        })
      : undefined;
  return {
    detail: `Chat bridge mode: ${protocol}`,
    config: {
      slack: compactObject({
        protocol,
        token,
        botToken,
        signing,
      }),
    },
  };
}

async function promptZulipConfig(prompt: ChatBridgePromptApi) {
  const email = await promptText(prompt, {
    message: "Enter the Zulip bot email.",
    placeholder: "bot@example.com",
    required: true,
  });
  const key = await promptText(prompt, {
    message: "Enter the Zulip bot API key.",
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

export async function promptChatBridgeSetup(prompt: ChatBridgePromptApi) {
  const enableChatBridge = prompt.ensureNotCancelled(
    await prompt.confirm({
      message: "Configure a chat bridge now?",
      initialValue: false,
    }),
  );

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
          hint:
            item.key === "telegram"
              ? "bot token"
              : item.key === "onebot"
                ? "endpoint + protocol"
                : "guided setup",
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
