import {
  detectLocalLanguageTag,
  normalizeLanguageTag,
  resolveInstallerDisplayLanguage,
  type InstallerDisplayLanguage,
} from "../language.js";

export type InstallerI18n = ReturnType<typeof createInstallerI18n>;

type InstallerLanguagePromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
};

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English", hint: "en" },
  { value: "zh-CN", label: "简体中文", hint: "zh-CN" },
  { value: "zh-TW", label: "繁體中文", hint: "zh-TW" },
  { value: "ja", label: "日本語", hint: "ja" },
  { value: "ko", label: "한국어", hint: "ko" },
  { value: "fr", label: "Français", hint: "fr" },
  { value: "es", label: "Español", hint: "es" },
  { value: "de", label: "Deutsch", hint: "de" },
  { value: "pt-BR", label: "Português (Brasil)", hint: "pt-BR" },
  { value: "ru", label: "Русский", hint: "ru" },
  { value: "ar", label: "العربية", hint: "ar" },
  { value: "hi", label: "हिन्दी", hint: "hi" },
  { value: "custom", label: "Other", hint: "Enter any BCP 47 language tag" },
] as const;

type InstallerLanguagePromptCopy = {
  chooseMessage: string;
  detectedSuffix: string;
  customLabel: string;
  customHint: string;
  textMessage: string;
  invalidLanguageTag: string;
};

type InstallerDisplayCopy = {
  chatBridgeLabel: string;
  chatBridgeModeLabel: string;
  chatAuthorizationLabel: string;
  confirmActiveLabel: string;
  confirmInactiveLabel: string;
  configureChatBridgeNowMessage: string;
  telegramTokenDetail: string;
  onebotEndpointGuide: string;
  onebotSelfIdGuide: string;
  onebotDetail: (protocol: string, endpoint: string) => string;
  discordDetail: string;
  qqDetail: string;
  larkDetail: (platform: string) => string;
  slackDetail: string;
  minecraftUrlGuide: string;
  minecraftSelfIdMessage: string;
  minecraftDetail: (url: string) => string;
  scheduledTaskAgentRunCost: string;
  chatAuthorizationLine: string;
};

const INSTALLER_LANGUAGE_PROMPT_COPY = {
  en: {
    chooseMessage: "Choose installer language",
    detectedSuffix: "detected",
    customLabel: "Other",
    customHint: "Enter any BCP 47 language tag",
    textMessage: "Enter language tag (BCP 47)",
    invalidLanguageTag: "Use a valid BCP 47 language tag",
  },
  "zh-CN": {
    chooseMessage: "选择安装器语言",
    detectedSuffix: "已检测",
    customLabel: "其他",
    customHint: "输入任意 BCP 47 语言标签",
    textMessage: "输入语言标签（BCP 47）",
    invalidLanguageTag: "请输入有效的 BCP 47 语言标签",
  },
} satisfies Record<InstallerDisplayLanguage, InstallerLanguagePromptCopy>;

const INSTALLER_DISPLAY_COPY = {
  en: {
    chatBridgeLabel: "Chat bridge",
    chatBridgeModeLabel: "Chat bridge mode",
    chatAuthorizationLabel: "Chat authorization",
    confirmActiveLabel: "Yes",
    confirmInactiveLabel: "No",
    configureChatBridgeNowMessage: "Configure a chat bridge now?",
    telegramTokenDetail:
      "Chat bridge mode: polling · token saved to target settings.json",
    onebotEndpointGuide:
      "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
    onebotSelfIdGuide:
      "Usually the bot QQ number from your OneBot client or bridge config.",
    onebotDetail: (protocol: string, endpoint: string) =>
      `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`,
    discordDetail: "Chat bridge token: [saved to target settings.json]",
    qqDetail:
      "Chat bridge mode: websocket · app credentials saved to target settings.json",
    larkDetail: (platform: string) =>
      `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
    slackDetail: "Chat bridge mode: ws",
    minecraftUrlGuide:
      "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
    minecraftSelfIdMessage:
      "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
    minecraftDetail: (url: string) => `Chat bridge mode: ws · endpoint: ${url}`,
    scheduledTaskAgentRunCost:
      "- scheduled task / chat-bridge-triggered agent runs that create their own turns",
    chatAuthorizationLine:
      "Chat authorization: installer guidance covers the first OWNER setup once; later role changes should be requested in normal conversation, not slash commands.",
  },
  "zh-CN": {
    chatBridgeLabel: "聊天接入",
    chatBridgeModeLabel: "聊天接入模式",
    chatAuthorizationLabel: "聊天授权",
    confirmActiveLabel: "是",
    confirmInactiveLabel: "否",
    configureChatBridgeNowMessage: "现在配置聊天接入吗？",
    telegramTokenDetail:
      "聊天接入模式：polling · 令牌已保存到目标 settings.json",
    onebotEndpointGuide:
      "你的 OneBot 接入服务或客户端配置，例如 NapCat、LLOneBot 或其他 OneBot 服务。",
    onebotSelfIdGuide: "通常是 OneBot 客户端或接入配置中的机器人 QQ 号。",
    onebotDetail: (protocol: string, endpoint: string) =>
      `聊天接入模式：${protocol} · 端点：${endpoint}`,
    discordDetail: "聊天接入令牌：[已保存到目标 settings.json]",
    qqDetail: "聊天接入模式：websocket · 应用凭据已保存到目标 settings.json",
    larkDetail: (platform: string) =>
      `聊天接入模式：ws · 平台：${platform} · 应用凭据已保存到目标 settings.json`,
    slackDetail: "聊天接入模式：ws",
    minecraftUrlGuide:
      "使用 QueQiao 接入服务或 Minecraft 适配器暴露出的 WebSocket 地址。",
    minecraftSelfIdMessage:
      "如果你想自定义 Minecraft 接入 self ID，请输入；否则留空使用 minecraft。",
    minecraftDetail: (url: string) => `聊天接入模式：ws · 端点：${url}`,
    scheduledTaskAgentRunCost: "- scheduled task / 聊天接入触发的 agent 运行",
    chatAuthorizationLine:
      "聊天授权：安装流程会一次性引导首次 OWNER 设置；后续角色变更应通过自然语言对话提出，不使用 slash command。",
  },
} satisfies Record<InstallerDisplayLanguage, InstallerDisplayCopy>;

function formatOpenLinks(links?: string | string[]) {
  const list = (Array.isArray(links) ? links : [links])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return list.join(" · ");
}

export async function promptInstallerLanguage(
  prompt: InstallerLanguagePromptApi,
) {
  const detected = detectLocalLanguageTag("en");
  const promptDisplayLanguage = resolveInstallerDisplayLanguage(detected);
  const copy = INSTALLER_LANGUAGE_PROMPT_COPY[promptDisplayLanguage];
  const selected = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: copy.chooseMessage,
        options: LANGUAGE_OPTIONS.map((option) => ({
          ...option,
          label: option.value === "custom" ? copy.customLabel : option.label,
          hint:
            option.value === "custom"
              ? copy.customHint
              : option.value === detected
                ? `${option.hint} · ${copy.detectedSuffix}`
                : option.hint,
        })),
      }),
    ),
  ).trim();
  if (selected !== "custom") return normalizeLanguageTag(selected, "en");
  return normalizeLanguageTag(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: copy.textMessage,
        placeholder: detected || "en",
        defaultValue: detected || "en",
        validate(value: string) {
          return normalizeLanguageTag(value, "")
            ? undefined
            : copy.invalidLanguageTag;
        },
      }),
    ),
    "en",
  );
}

export function createInstallerI18n(languageTag = "en") {
  const language = normalizeLanguageTag(languageTag, "en");
  const displayLanguage = resolveInstallerDisplayLanguage(language);
  const copy = INSTALLER_DISPLAY_COPY[displayLanguage];
  const local = <T>(values: Record<InstallerDisplayLanguage, T>) =>
    values[displayLanguage];

  return {
    language,
    displayLanguage,
    isChinese: displayLanguage === "zh-CN",
    installerCancelled: local({
      en: "Installer cancelled.",
      "zh-CN": "安装器已取消。",
    }),
    introTitle: local({ en: "Rin Installer", "zh-CN": "Rin 安装器" }),
    safetyBoundaryTitle: local({ en: "Safety boundary", "zh-CN": "安全边界" }),
    targetUserTitle: local({ en: "Target user", "zh-CN": "目标用户" }),
    installChoicesTitle: local({ en: "Install choices", "zh-CN": "安装选项" }),
    ownershipCheckTitle: local({
      en: "Ownership check",
      "zh-CN": "所有权检查",
    }),
    writtenPathsTitle: local({ en: "Written paths", "zh-CN": "已写入路径" }),
    targetInstallDirLabel: local({
      en: "Target install dir",
      "zh-CN": "目标安装目录",
    }),
    writtenPathLabel: local({ en: "Written", "zh-CN": "已写入" }),
    serviceLabelLabel: local({ en: "label", "zh-CN": "标签" }),
    launchingInitTitle: local({ en: "Launching init", "zh-CN": "启动初始化" }),
    afterInitTitle: local({ en: "After init", "zh-CN": "初始化后" }),
    confirmActiveLabel: copy.confirmActiveLabel,
    confirmInactiveLabel: copy.confirmInactiveLabel,
    existingDirectoryTitle: local({
      en: "Existing directory",
      "zh-CN": "已有目录",
    }),
    installDirectoryTitle: local({
      en: "Install directory",
      "zh-CN": "安装目录",
    }),
    currentUserLabel: local({ en: "Current user", "zh-CN": "当前用户" }),
    existingOtherUserLabel: local({
      en: "Existing other user",
      "zh-CN": "现有其他用户",
    }),
    newUserLabel: local({ en: "New user", "zh-CN": "新用户" }),
    noneFoundHint: local({ en: "none found", "zh-CN": "未找到" }),
    usersHint: (count: number) =>
      local({ en: `${count} user(s)`, "zh-CN": `共 ${count} 个用户` }),
    newUserHint: local({ en: "enter a username", "zh-CN": "输入用户名" }),
    existingDirectoryText: (
      installDir: string,
      entryCount: number,
      sample: string[],
    ) =>
      [
        `${local({ en: "Directory exists", "zh-CN": "目录已存在" })}: ${installDir}`,
        `${local({ en: "Existing entries", "zh-CN": "现有条目数" })}: ${entryCount}`,
        sample.length
          ? `${local({ en: "Sample", "zh-CN": "示例" })}: ${sample.join(", ")}`
          : "",
        "",
        local({ en: "Installer policy:", "zh-CN": "安装器策略：" }),
        local({
          en: "- keep unknown files untouched",
          "zh-CN": "- 保留未知文件不动",
        }),
        local({
          en: "- keep existing config unless a required file must be updated",
          "zh-CN": "- 保留现有配置，除非必须更新所需文件",
        }),
        local({
          en: "- only remove old files when they are known legacy Rin artifacts",
          "zh-CN": "- 仅在确认属于旧版 Rin 遗留物时才删除旧文件",
        }),
      ]
        .filter(Boolean)
        .join("\n"),
    newDirectoryText: (installDir: string) =>
      [
        `${local({ en: "Directory will be created", "zh-CN": "将创建目录" })}: ${installDir}`,
        "",
        local({ en: "Installer policy:", "zh-CN": "安装器策略：" }),
        local({
          en: "- create only the files Rin needs",
          "zh-CN": "- 仅创建 Rin 必需的文件",
        }),
        local({
          en: "- future updates should preserve unknown files",
          "zh-CN": "- 未来更新应保留未知文件",
        }),
      ].join("\n"),
    chooseTargetUserMessage: local({
      en: "Choose the target user for the Rin daemon.",
      "zh-CN": "选择 Rin 守护进程的目标用户。",
    }),
    chooseExistingUserMessage: local({
      en: "Choose the existing user to host the Rin daemon.",
      "zh-CN": "选择承载 Rin 守护进程的现有用户。",
    }),
    enterNewUsernameMessage: local({
      en: "Enter the new username to create for the Rin daemon.",
      "zh-CN": "输入要为 Rin 守护进程创建的新用户名。",
    }),
    usernamePlaceholder: "rin",
    usernameRequired: local({
      en: "Username is required.",
      "zh-CN": "用户名不能为空。",
    }),
    usernameInvalid: local({
      en: "Use a normal Unix username.",
      "zh-CN": "请输入正常的 Unix 用户名。",
    }),
    chooseInstallDirMessage: local({
      en: "Choose the Rin data directory for the daemon user.",
      "zh-CN": "选择该守护进程用户的 Rin 数据目录。",
    }),
    chooseDefaultTargetMessage: (targetUser: string) =>
      local({
        en: `Set ${targetUser} as the default target user for future rin / rin update runs from this launcher user?`,
        "zh-CN": `是否将 ${targetUser} 设为当前安装器用户后续运行 rin / rin update 时的默认目标用户？`,
      }),
    defaultTargetLabel: local({
      en: "Default target user",
      "zh-CN": "默认目标用户",
    }),
    defaultTargetSetValue: (targetUser: string) =>
      local({ en: `set to ${targetUser}`, "zh-CN": `设为 ${targetUser}` }),
    defaultTargetSkippedValue: local({ en: "not set", "zh-CN": "不设置" }),
    directoryRequired: local({
      en: "Directory is required.",
      "zh-CN": "目录不能为空。",
    }),
    directoryMustBeAbsolute: local({
      en: "Use an absolute path.",
      "zh-CN": "请输入绝对路径。",
    }),
    chooseProviderMessage: local({
      en: "Choose a provider to authenticate and use.",
      "zh-CN": "选择要认证并使用的模型提供商。",
    }),
    chooseModelMessage: local({ en: "Choose a model.", "zh-CN": "选择模型。" }),
    chooseThinkingLevelMessage: local({
      en: "Choose the default thinking level.",
      "zh-CN": "选择默认思考强度。",
    }),
    providerReadyHint: local({ en: "ready", "zh-CN": "已就绪" }),
    providerNeedsAuthHint: local({
      en: "needs auth/config",
      "zh-CN": "需要认证/配置",
    }),
    reasoningHint: local({ en: "reasoning", "zh-CN": "推理" }),
    noReasoningHint: local({ en: "no reasoning", "zh-CN": "无推理" }),
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    whereToFindLabel: local({ en: "Where to find it", "zh-CN": "获取位置" }),
    openLabel: local({ en: "Open", "zh-CN": "打开" }),
    fieldRequired: local({
      en: "This field is required.",
      "zh-CN": "此项必填。",
    }),
    valueRequired: local({
      en: "A value is required.",
      "zh-CN": "此项不能为空。",
    }),
    validUrlRequired: local({
      en: "Use a valid URL.",
      "zh-CN": "请输入有效 URL。",
    }),
    configureChatBridgeNowMessage: copy.configureChatBridgeNowMessage,
    chooseChatPlatformMessage: local({
      en: "Choose a chat platform.",
      "zh-CN": "选择聊天平台。",
    }),
    guidedSetupHint: local({ en: "guided setup", "zh-CN": "引导配置" }),
    telegramHint: local({ en: "bot token", "zh-CN": "机器人令牌" }),
    onebotHint: local({ en: "endpoint + protocol", "zh-CN": "端点 + 协议" }),
    slackHint: "app token + bot token",
    buildGuide(message: string, guide?: string, links?: string | string[]) {
      const lines = [message.trim()];
      if (guide) lines.push(`${this.whereToFindLabel}: ${guide.trim()}`);
      const openLinks = formatOpenLinks(links);
      if (openLinks) lines.push(`${this.openLabel}: ${openLinks}`);
      return lines.join("\n");
    },
    chatDisabledDescription: local({
      en: "disabled for now",
      "zh-CN": "暂不启用",
    }),
    telegramTokenMessage: local({
      en: "Enter the Telegram bot token.",
      "zh-CN": "输入 Telegram 机器人令牌。",
    }),
    telegramTokenGuide: local({
      en: "Telegram @BotFather → choose your bot → API token.",
      "zh-CN": "Telegram @BotFather → 选择你的机器人 → API token。",
    }),
    telegramTokenDetail: copy.telegramTokenDetail,
    onebotEndpointMessage: local({
      en: "Enter the OneBot endpoint URL.",
      "zh-CN": "输入 OneBot 端点 URL。",
    }),
    onebotEndpointGuide: copy.onebotEndpointGuide,
    onebotSelfIdMessage: local({
      en: "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
      "zh-CN": "如果你已经知道 OneBot self ID，请输入；否则留空稍后再填。",
    }),
    onebotSelfIdGuide: copy.onebotSelfIdGuide,
    onebotTokenMessage: local({
      en: "Enter the OneBot access token if required. Leave blank otherwise.",
      "zh-CN": "如果需要，请输入 OneBot access token；否则留空。",
    }),
    onebotTokenGuide: local({
      en: "Use the access token from your OneBot server config only if you enabled one.",
      "zh-CN": "仅在你的 OneBot 服务端配置启用了 access token 时填写。",
    }),
    optionalTokenPlaceholder: local({
      en: "optional token",
      "zh-CN": "可选令牌",
    }),
    onebotDetail: copy.onebotDetail,
    discordTokenMessage: local({
      en: "Enter the Discord bot token.",
      "zh-CN": "输入 Discord 机器人令牌。",
    }),
    discordTokenGuide: local({
      en: "Discord Developer Portal → your application → Bot → Reset Token / Token.",
      "zh-CN":
        "Discord Developer Portal → 你的应用 → Bot → Reset Token / Token。",
    }),
    discordDetail: copy.discordDetail,
    qqAppIdMessage: local({
      en: "Enter the QQ bot app ID.",
      "zh-CN": "输入 QQ 机器人 App ID。",
    }),
    qqCredentialsGuide: local({
      en: "QQ bot developer docs → create your bot application → app credentials.",
      "zh-CN": "QQ 机器人开发者文档 → 创建机器人应用 → app 凭据。",
    }),
    qqSecretMessage: local({
      en: "Enter the QQ bot secret.",
      "zh-CN": "输入 QQ 机器人密钥。",
    }),
    qqTokenMessage: local({
      en: "Enter the QQ bot token.",
      "zh-CN": "输入 QQ 机器人令牌。",
    }),
    qqScopeMessage: local({
      en: "Choose the QQ bot scope.",
      "zh-CN": "选择 QQ 机器人范围。",
    }),
    qqScopeGuide: local({
      en: "Use the bot type shown in your QQ bot application settings.",
      "zh-CN": "使用 QQ 机器人应用设置中显示的机器人类型。",
    }),
    publicLabel: local({ en: "Public", "zh-CN": "公开" }),
    privateLabel: local({ en: "Private", "zh-CN": "私有" }),
    qqDetail: copy.qqDetail,
    larkPlatformMessage: local({
      en: "Choose the Lark / Feishu region.",
      "zh-CN": "选择 Lark / 飞书区域。",
    }),
    larkPlatformGuide: local({
      en: "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
      "zh-CN":
        "如果你的应用在 open.feishu.cn 上，选飞书；如果在 open.larksuite.com 上，选 Lark。",
    }),
    feishuLabel: "Feishu",
    larkLabel: "Lark",
    feishuHint: local({
      en: "China / open.feishu.cn",
      "zh-CN": "中国 / open.feishu.cn",
    }),
    larkHint: local({
      en: "Global / open.larksuite.com",
      "zh-CN": "全球 / open.larksuite.com",
    }),
    larkAppIdMessage: local({
      en: "Enter the Lark / Feishu app ID.",
      "zh-CN": "输入 Lark / 飞书 app ID。",
    }),
    larkAppIdGuide: local({
      en: "Developer console → your app → Credentials / Basic information.",
      "zh-CN": "开发者后台 → 你的应用 → 凭据 / 基本信息。",
    }),
    larkAppSecretMessage: local({
      en: "Enter the Lark / Feishu app secret.",
      "zh-CN": "输入 Lark / 飞书 app secret。",
    }),
    larkDetail: copy.larkDetail,
    slackAppTokenMessage: local({
      en: "Enter the Slack app-level token.",
      "zh-CN": "输入 Slack app-level token。",
    }),
    slackAppTokenGuide: local({
      en: "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
      "zh-CN":
        "Slack 应用设置 → Basic Information 或 Socket Mode → App-Level Tokens（以 xapp- 开头）。",
    }),
    slackBotTokenMessage: local({
      en: "Enter the Slack bot token.",
      "zh-CN": "输入 Slack bot token。",
    }),
    slackBotTokenGuide: local({
      en: "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
      "zh-CN":
        "Slack 应用设置 → OAuth & Permissions → Bot User OAuth Token（以 xoxb- 开头）。",
    }),
    slackDetail: copy.slackDetail,
    minecraftUrlMessage: local({
      en: "Enter the Minecraft QueQiao WebSocket URL.",
      "zh-CN": "输入 Minecraft QueQiao WebSocket URL。",
    }),
    minecraftUrlGuide: copy.minecraftUrlGuide,
    minecraftSelfIdMessage: copy.minecraftSelfIdMessage,
    minecraftServerNameMessage: local({
      en: "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
      "zh-CN":
        "如果你希望聊天日志显示 Minecraft 服务器名称，请输入；否则留空。",
    }),
    minecraftTokenMessage: local({
      en: "Enter the QueQiao access token if required. Leave blank otherwise.",
      "zh-CN": "如果需要，请输入 QueQiao access token；否则留空。",
    }),
    minecraftDetail: copy.minecraftDetail,
    buildInstallSafetyBoundaryText() {
      return [
        local({ en: "Rin safety boundary:", "zh-CN": "Rin 安全边界：" }),
        local({
          en: "- Rin always runs in YOLO mode.",
          "zh-CN": "- Rin 始终运行在 YOLO 模式。",
        }),
        local({
          en: "- There is no sandbox for shell/file actions.",
          "zh-CN": "- shell / 文件操作没有沙箱。",
        }),
        local({
          en: "- Rin acts with the full user-level permissions of the selected system account.",
          "zh-CN": "- Rin 将以所选系统账号的完整用户级权限运行。",
        }),
        local({
          en: "- It may read files, modify files, run commands, and access network resources available to that account.",
          "zh-CN":
            "- 它可能读取文件、修改文件、执行命令，并访问该账号可用的网络资源。",
        }),
        local({
          en: "- Prompts, tool outputs, file contents, memory context, and search results may be sent to the active model/provider, so sensitive data may be exposed.",
          "zh-CN":
            "- 提示词、工具输出、文件内容、记忆上下文与搜索结果可能会发送给当前模型/提供商，因此敏感数据可能暴露。",
        }),
        "",
        local({
          en: "Possible extra token overhead beyond your visible chat turns:",
          "zh-CN": "除可见聊天轮次外，可能产生额外 Token 开销：",
        }),
        local({
          en: "- memory prompt blocks injected into normal turns",
          "zh-CN": "- 正常轮次中注入的记忆提示块",
        }),
        local({
          en: "- the first-run /init onboarding conversation",
          "zh-CN": "- 首次运行的 /init 引导对话",
        }),
        local({
          en: "- memory extraction during session shutdown or `/new` handoff",
          "zh-CN": "- 会话关闭或 `/new` 交接时的记忆提取",
        }),
        local({
          en: "- episode synthesis during session shutdown or `/new` handoff",
          "zh-CN": "- 会话关闭或 `/new` 交接时的 episode 综合",
        }),
        local({
          en: "- context compaction / summarization when the session grows large",
          "zh-CN": "- 会话上下文过大时的压缩 / 总结",
        }),
        local({
          en: "- subagent runs when the assistant chooses or is asked to delegate work",
          "zh-CN": "- assistant 主动选择或按要求委派的 subagent 运行",
        }),
        copy.scheduledTaskAgentRunCost,
        local({
          en: "- web-search result text added into the model context when search is used",
          "zh-CN": "- 使用 web search 时加入模型上下文的搜索结果文本",
        }),
      ].join("\n");
    },
    buildInstallPlanText(options: {
      targetUser: string;
      installDir: string;
      provider: string;
      modelId: string;
      thinkingLevel: string;
      authAvailable: boolean;
      chatDescription: string;
      chatDetail: string;
      language: string;
      setDefaultTarget: boolean;
    }) {
      const skippedForNow = local({
        en: "skipped for now",
        "zh-CN": "暂不设置",
      });
      const authStatus = options.provider
        ? options.authAvailable
          ? local({ en: "ready", "zh-CN": "已就绪" })
          : local({
              en: "needs auth/config later",
              "zh-CN": "稍后需要认证/配置",
            })
        : skippedForNow;
      return [
        `${local({ en: "Target daemon user", "zh-CN": "目标守护进程用户" })}: ${options.targetUser}`,
        `${local({ en: "Install dir", "zh-CN": "安装目录" })}: ${options.installDir}`,
        `${local({ en: "Language", "zh-CN": "语言" })}: ${options.language}`,
        `${local({ en: "Provider", "zh-CN": "提供商" })}: ${options.provider || skippedForNow}`,
        `${local({ en: "Model", "zh-CN": "模型" })}: ${options.modelId || skippedForNow}`,
        `${local({ en: "Thinking level", "zh-CN": "思考强度" })}: ${options.thinkingLevel || skippedForNow}`,
        `${local({ en: "Model auth status", "zh-CN": "模型认证状态" })}: ${authStatus}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
        `${copy.chatBridgeLabel}: ${options.chatDescription}`,
        options.chatDetail,
        options.chatDescription === this.chatDisabledDescription
          ? ""
          : copy.chatAuthorizationLine,
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildPostInstallInitExitText(options: {
      currentUser: string;
      targetUser: string;
    }) {
      const userSuffix =
        options.currentUser === options.targetUser
          ? ""
          : ` -u ${options.targetUser}`;
      return [
        local({
          en: "Initialization TUI exited.",
          "zh-CN": "初始化 TUI 已退出。",
        }),
        "",
        local({ en: "Next time:", "zh-CN": "下次可用：" }),
        `${local({ en: "- open Rin", "zh-CN": "- 打开 Rin" })}: rin${userSuffix}`,
        `${local({ en: "- check daemon state if needed", "zh-CN": "- 如有需要，检查守护进程状态" })}: rin doctor${userSuffix}`,
        local({
          en: "- restart onboarding from inside Rin with `/init`",
          "zh-CN": "- 在 Rin 内通过 `/init` 重新开始引导",
        }),
      ].join("\n");
    },
    buildFinalRequirements(options: {
      installServiceNow: boolean;
      needsElevatedWrite: boolean;
      needsElevatedService: boolean;
    }) {
      return [
        local({
          en: "write configuration and launchers",
          "zh-CN": "写入配置与启动器",
        }),
        local({
          en: "publish the runtime into the install directory",
          "zh-CN": "将运行时发布到安装目录",
        }),
        options.installServiceNow
          ? local({
              en: "install and start the daemon service",
              "zh-CN": "安装并启动守护进程服务",
            })
          : local({
              en: "skip daemon service installation on this platform",
              "zh-CN": "在此平台上跳过守护进程服务安装",
            }),
        options.needsElevatedWrite || options.needsElevatedService
          ? local({
              en: "use sudo/doas if needed for the selected target and install dir",
              "zh-CN": "如目标用户或安装目录需要，请使用 sudo/doas",
            })
          : local({
              en: "no extra privilege escalation currently predicted",
              "zh-CN": "当前预计不需要额外提权",
            }),
      ];
    },
    finalizeInstallationMessage(finalRequirements: string[]) {
      return [
        local({
          en: "Finalize installation now?",
          "zh-CN": "现在完成安装吗？",
        }),
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n");
    },
    noEligibleUsersText(currentUser: string, visibleUsers: string[]) {
      return [
        local({
          en: "No eligible existing users were found on this system.",
          "zh-CN": "在当前系统上未找到可选的现有用户。",
        }),
        `${local({ en: "Detected current user", "zh-CN": "检测到的当前用户" })}: ${currentUser}`,
        `${local({ en: "Visible users", "zh-CN": "可见用户" })}: ${visibleUsers.join(", ") || local({ en: "none", "zh-CN": "无" })}`,
      ].join("\n");
    },
    nothingInstalled: local({
      en: "Nothing installed.",
      "zh-CN": "未执行安装。",
    }),
    installerFinishedWithoutWritingChanges: local({
      en: "Installer finished without writing changes.",
      "zh-CN": "安装器结束，未写入变更。",
    }),
    ownershipMismatchText(ownership: {
      statUid: number;
      statGid: number;
      targetUid: number;
      targetGid: number;
    }) {
      return [
        `${local({ en: "Target dir owner uid/gid", "zh-CN": "目标目录 owner uid/gid" })}: ${ownership.statUid}:${ownership.statGid}`,
        `${local({ en: "Target user uid/gid", "zh-CN": "目标用户 uid/gid" })}: ${ownership.targetUid}:${ownership.targetGid}`,
        local({
          en: "This directory is not currently owned by the selected target user.",
          "zh-CN": "该目录当前并不归所选目标用户所有。",
        }),
        local({
          en: "The installer will still write config if it can, but you may want to fix ownership before switching fully.",
          "zh-CN":
            "如果安装器有权限，它仍会继续写入配置，但在完全切换前你可能需要先修复所有权。",
        }),
      ].join("\n");
    },
    ownershipNotWritableText: local({
      en: "The selected install directory is not writable by the current installer process.",
      "zh-CN": "当前安装器进程对所选安装目录没有写权限。",
    }),
    publishingRuntimeMessageElevated: local({
      en: "Publishing runtime and writing configuration with elevated permissions...",
      "zh-CN": "正在以提权方式发布运行时并写入配置……",
    }),
    publishingRuntimeMessage: local({
      en: "Publishing runtime and writing configuration...",
      "zh-CN": "正在发布运行时并写入配置……",
    }),
    launchingInitText: local({
      en: [
        "Installation is done. Rin will now open an initialization TUI.",
        "You can exit it anytime; the installer will print the next-step reminder afterwards.",
      ].join("\n"),
      "zh-CN": [
        "安装已完成。Rin 现在将打开初始化 TUI。",
        "你可以随时退出；安装器随后会打印下一步提示。",
      ].join("\n"),
    }),
    outroInstalled(targetUser: string, installedServiceKind?: string) {
      return local({
        en: `Installer wrote config for ${targetUser}.${installedServiceKind ? ` (${installedServiceKind} service installed).` : ""}`,
        "zh-CN": `已为 ${targetUser} 写入安装配置。${installedServiceKind ? `（已安装 ${installedServiceKind} 服务。）` : ""}`,
      });
    },
    installStepFailed: local({
      en: "Install step failed.",
      "zh-CN": "安装步骤失败。",
    }),
    installStepComplete: local({
      en: "Install step complete.",
      "zh-CN": "安装步骤完成。",
    }),
    startingLogin(providerName: string) {
      return local({
        en: `Starting ${providerName} login...`,
        "zh-CN": `正在启动 ${providerName} 登录……`,
      });
    },
    openUrlToContinueLogin(url: string, instructions?: string) {
      return local({
        en: `Open this URL to continue login:\n${url}${instructions ? `\n${instructions}` : ""}`,
        "zh-CN": `打开以下链接以继续登录：\n${url}${instructions ? `\n${instructions}` : ""}`,
      });
    },
    enterLoginValueMessage: local({
      en: "Enter login value.",
      "zh-CN": "输入登录所需的值。",
    }),
    waitingForLogin(providerName: string) {
      return local({
        en: `Waiting for ${providerName} login...`,
        "zh-CN": `正在等待 ${providerName} 登录……`,
      });
    },
    manualCodeInputMessage: local({
      en: "Paste the redirect URL or code from the browser.",
      "zh-CN": "粘贴浏览器中的回调 URL 或验证码。",
    }),
    manualCodePlaceholder(lastAuthUrl: string) {
      return lastAuthUrl
        ? local({
            en: "paste the final redirect URL or device code",
            "zh-CN": "粘贴最终回调 URL 或设备验证码",
          })
        : local({ en: "paste the code", "zh-CN": "粘贴验证码" });
    },
    loginComplete(providerName: string) {
      return local({
        en: `${providerName} login complete.`,
        "zh-CN": `${providerName} 登录完成。`,
      });
    },
    loginFailed(providerName: string) {
      return local({
        en: `Login failed for ${providerName}.`,
        "zh-CN": `${providerName} 登录失败。`,
      });
    },
    enterApiKeyMessage(providerName: string) {
      return local({
        en: `Enter the API key or token for ${providerName}.`,
        "zh-CN": `输入 ${providerName} 的 API key 或 token。`,
      });
    },
    tokenRequired: local({
      en: "A token is required.",
      "zh-CN": "Token 不能为空。",
    }),
  };
}
