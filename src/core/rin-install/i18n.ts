import {
  detectLocalLanguageTag,
  normalizeLanguageTag,
  resolveInstallerDisplayLanguage,
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

const INSTALLER_LANGUAGE_PROMPT_COPY: InstallerLanguagePromptCopy = {
  chooseMessage: "Choose installer language",
  detectedSuffix: "detected",
  customLabel: "Other",
  customHint: "Enter any BCP 47 language tag",
  textMessage: "Enter language tag (BCP 47)",
  invalidLanguageTag: "Use a valid BCP 47 language tag",
};

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
  const copy = INSTALLER_LANGUAGE_PROMPT_COPY;
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
  const zh = displayLanguage === "zh-CN";

  return {
    language,
    displayLanguage,
    isChinese: zh,
    installerCancelled: zh ? "安装器已取消。" : "Installer cancelled.",
    introTitle: zh ? "Rin 安装器" : "Rin Installer",
    safetyBoundaryTitle: zh ? "安全边界" : "Safety boundary",
    targetUserTitle: zh ? "目标用户" : "Target user",
    installChoicesTitle: zh ? "安装选项" : "Install choices",
    ownershipCheckTitle: zh ? "所有权检查" : "Ownership check",
    writtenPathsTitle: zh ? "已写入路径" : "Written paths",
    targetInstallDirLabel: zh ? "目标安装目录" : "Target install dir",
    writtenPathLabel: zh ? "已写入" : "Written",
    serviceLabelLabel: zh ? "标签" : "label",
    launchingInitTitle: zh ? "启动初始化" : "Launching init",
    afterInitTitle: zh ? "初始化后" : "After init",
    confirmActiveLabel: zh ? "是" : "Yes",
    confirmInactiveLabel: zh ? "否" : "No",
    existingDirectoryTitle: zh ? "已有目录" : "Existing directory",
    installDirectoryTitle: zh ? "安装目录" : "Install directory",
    currentUserLabel: zh ? "当前用户" : "Current user",
    existingOtherUserLabel: zh ? "现有其他用户" : "Existing other user",
    newUserLabel: zh ? "新用户" : "New user",
    noneFoundHint: zh ? "未找到" : "none found",
    usersHint: (count: number) =>
      zh ? `共 ${count} 个用户` : `${count} user(s)`,
    newUserHint: zh ? "输入用户名" : "enter a username",
    existingDirectoryText: (
      installDir: string,
      entryCount: number,
      sample: string[],
    ) =>
      [
        `${zh ? "目录已存在" : "Directory exists"}: ${installDir}`,
        `${zh ? "现有条目数" : "Existing entries"}: ${entryCount}`,
        sample.length ? `${zh ? "示例" : "Sample"}: ${sample.join(", ")}` : "",
        "",
        zh ? "安装器策略：" : "Installer policy:",
        zh ? "- 保留未知文件不动" : "- keep unknown files untouched",
        zh
          ? "- 保留现有配置，除非必须更新所需文件"
          : "- keep existing config unless a required file must be updated",
        zh
          ? "- 仅在确认属于旧版 Rin 遗留物时才删除旧文件"
          : "- only remove old files when they are known legacy Rin artifacts",
      ]
        .filter(Boolean)
        .join("\n"),
    newDirectoryText: (installDir: string) =>
      [
        `${zh ? "将创建目录" : "Directory will be created"}: ${installDir}`,
        "",
        zh ? "安装器策略：" : "Installer policy:",
        zh ? "- 仅创建 Rin 必需的文件" : "- create only the files Rin needs",
        zh
          ? "- 未来更新应保留未知文件"
          : "- future updates should preserve unknown files",
      ].join("\n"),
    chooseTargetUserMessage: zh
      ? "选择 Rin 守护进程的目标用户。"
      : "Choose the target user for the Rin daemon.",
    chooseExistingUserMessage: zh
      ? "选择承载 Rin 守护进程的现有用户。"
      : "Choose the existing user to host the Rin daemon.",
    enterNewUsernameMessage: zh
      ? "输入要为 Rin 守护进程创建的新用户名。"
      : "Enter the new username to create for the Rin daemon.",
    usernamePlaceholder: "rin",
    usernameRequired: zh ? "用户名不能为空。" : "Username is required.",
    usernameInvalid: zh
      ? "请输入正常的 Unix 用户名。"
      : "Use a normal Unix username.",
    chooseInstallDirMessage: zh
      ? "选择该守护进程用户的 Rin 数据目录。"
      : "Choose the Rin data directory for the daemon user.",
    chooseDefaultTargetMessage: (targetUser: string) =>
      zh
        ? `是否将 ${targetUser} 设为当前安装器用户后续运行 rin / rin update 时的默认目标用户？`
        : `Set ${targetUser} as the default target user for future rin / rin update runs from this launcher user?`,
    defaultTargetLabel: zh ? "默认目标用户" : "Default target user",
    defaultTargetSetValue: (targetUser: string) =>
      zh ? `设为 ${targetUser}` : `set to ${targetUser}`,
    defaultTargetSkippedValue: zh ? "不设置" : "not set",
    directoryRequired: zh ? "目录不能为空。" : "Directory is required.",
    directoryMustBeAbsolute: zh ? "请输入绝对路径。" : "Use an absolute path.",
    chooseProviderMessage: zh
      ? "选择要认证并使用的模型提供商。"
      : "Choose a provider to authenticate and use.",
    chooseModelMessage: zh ? "选择模型。" : "Choose a model.",
    chooseThinkingLevelMessage: zh
      ? "选择默认思考强度。"
      : "Choose the default thinking level.",
    providerReadyHint: zh ? "已就绪" : "ready",
    providerNeedsAuthHint: zh ? "需要认证/配置" : "needs auth/config",
    reasoningHint: zh ? "推理" : "reasoning",
    noReasoningHint: zh ? "无推理" : "no reasoning",
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    whereToFindLabel: zh ? "获取位置" : "Where to find it",
    openLabel: zh ? "打开" : "Open",
    fieldRequired: zh ? "此项必填。" : "This field is required.",
    valueRequired: zh ? "此项不能为空。" : "A value is required.",
    validUrlRequired: zh ? "请输入有效 URL。" : "Use a valid URL.",
    configureChatBridgeNowMessage: zh
      ? "现在配置 chat bridge 吗？"
      : "Configure a chat bridge now?",
    chooseChatPlatformMessage: zh
      ? "选择聊天平台。"
      : "Choose a chat platform.",
    guidedSetupHint: zh ? "引导配置" : "guided setup",
    telegramHint: zh ? "机器人令牌" : "bot token",
    onebotHint: zh ? "端点 + 协议" : "endpoint + protocol",
    slackHint: zh ? "app token + bot token" : "app token + bot token",
    buildGuide(message: string, guide?: string, links?: string | string[]) {
      const lines = [message.trim()];
      if (guide) lines.push(`${this.whereToFindLabel}: ${guide.trim()}`);
      const openLinks = formatOpenLinks(links);
      if (openLinks) lines.push(`${this.openLabel}: ${openLinks}`);
      return lines.join("\n");
    },
    chatDisabledDescription: zh ? "暂不启用" : "disabled for now",
    telegramTokenMessage: zh
      ? "输入 Telegram 机器人令牌。"
      : "Enter the Telegram bot token.",
    telegramTokenGuide: zh
      ? "Telegram @BotFather → 选择你的机器人 → API token。"
      : "Telegram @BotFather → choose your bot → API token.",
    telegramTokenDetail: zh
      ? "Chat bridge 模式：polling · 令牌已保存到目标 settings.json"
      : "Chat bridge mode: polling · token saved to target settings.json",
    onebotEndpointMessage: zh
      ? "输入 OneBot 端点 URL。"
      : "Enter the OneBot endpoint URL.",
    onebotEndpointGuide: zh
      ? "你的 OneBot bridge 或客户端配置，例如 NapCat、LLOneBot 或其他 OneBot 服务。"
      : "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
    onebotSelfIdMessage: zh
      ? "如果你已经知道 OneBot self ID，请输入；否则留空稍后再填。"
      : "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
    onebotSelfIdGuide: zh
      ? "通常是 OneBot 客户端或 bridge 配置中的机器人 QQ 号。"
      : "Usually the bot QQ number from your OneBot client or bridge config.",
    onebotTokenMessage: zh
      ? "如果需要，请输入 OneBot access token；否则留空。"
      : "Enter the OneBot access token if required. Leave blank otherwise.",
    onebotTokenGuide: zh
      ? "仅在你的 OneBot 服务端配置启用了 access token 时填写。"
      : "Use the access token from your OneBot server config only if you enabled one.",
    optionalTokenPlaceholder: zh ? "可选令牌" : "optional token",
    onebotDetail: (protocol: string, endpoint: string) =>
      zh
        ? `Chat bridge 模式：${protocol} · 端点：${endpoint}`
        : `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`,
    discordTokenMessage: zh
      ? "输入 Discord 机器人令牌。"
      : "Enter the Discord bot token.",
    discordTokenGuide: zh
      ? "Discord Developer Portal → 你的应用 → Bot → Reset Token / Token。"
      : "Discord Developer Portal → your application → Bot → Reset Token / Token.",
    discordDetail: zh
      ? "Chat bridge 令牌：[已保存到目标 settings.json]"
      : "Chat bridge token: [saved to target settings.json]",
    qqAppIdMessage: zh ? "输入 QQ 机器人 App ID。" : "Enter the QQ bot app ID.",
    qqCredentialsGuide: zh
      ? "QQ 机器人开发者文档 → 创建机器人应用 → app 凭据。"
      : "QQ bot developer docs → create your bot application → app credentials.",
    qqSecretMessage: zh ? "输入 QQ 机器人密钥。" : "Enter the QQ bot secret.",
    qqTokenMessage: zh ? "输入 QQ 机器人令牌。" : "Enter the QQ bot token.",
    qqScopeMessage: zh ? "选择 QQ 机器人范围。" : "Choose the QQ bot scope.",
    qqScopeGuide: zh
      ? "使用 QQ 机器人应用设置中显示的机器人类型。"
      : "Use the bot type shown in your QQ bot application settings.",
    publicLabel: zh ? "公开" : "Public",
    privateLabel: zh ? "私有" : "Private",
    qqDetail: zh
      ? "Chat bridge 模式：websocket · 应用凭据已保存到目标 settings.json"
      : "Chat bridge mode: websocket · app credentials saved to target settings.json",
    larkPlatformMessage: zh
      ? "选择 Lark / 飞书区域。"
      : "Choose the Lark / Feishu region.",
    larkPlatformGuide: zh
      ? "如果你的应用在 open.feishu.cn 上，选飞书；如果在 open.larksuite.com 上，选 Lark。"
      : "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
    feishuLabel: "Feishu",
    larkLabel: "Lark",
    feishuHint: zh ? "中国 / open.feishu.cn" : "China / open.feishu.cn",
    larkHint: zh ? "全球 / open.larksuite.com" : "Global / open.larksuite.com",
    larkAppIdMessage: zh
      ? "输入 Lark / 飞书 app ID。"
      : "Enter the Lark / Feishu app ID.",
    larkAppIdGuide: zh
      ? "开发者后台 → 你的应用 → 凭据 / 基本信息。"
      : "Developer console → your app → Credentials / Basic information.",
    larkAppSecretMessage: zh
      ? "输入 Lark / 飞书 app secret。"
      : "Enter the Lark / Feishu app secret.",
    larkDetail: (platform: string) =>
      zh
        ? `Chat bridge 模式：ws · 平台：${platform} · 应用凭据已保存到目标 settings.json`
        : `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
    slackAppTokenMessage: zh
      ? "输入 Slack app-level token。"
      : "Enter the Slack app-level token.",
    slackAppTokenGuide: zh
      ? "Slack 应用设置 → Basic Information 或 Socket Mode → App-Level Tokens（以 xapp- 开头）。"
      : "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
    slackBotTokenMessage: zh
      ? "输入 Slack bot token。"
      : "Enter the Slack bot token.",
    slackBotTokenGuide: zh
      ? "Slack 应用设置 → OAuth & Permissions → Bot User OAuth Token（以 xoxb- 开头）。"
      : "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
    slackDetail: zh ? "Chat bridge 模式：ws" : "Chat bridge mode: ws",
    minecraftUrlMessage: zh
      ? "输入 Minecraft QueQiao WebSocket URL。"
      : "Enter the Minecraft QueQiao WebSocket URL.",
    minecraftUrlGuide: zh
      ? "使用 QueQiao bridge 或 Minecraft 适配器暴露出的 WebSocket 地址。"
      : "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
    minecraftSelfIdMessage: zh
      ? "如果你想自定义 Minecraft bridge self ID，请输入；否则留空使用 minecraft。"
      : "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
    minecraftServerNameMessage: zh
      ? "如果你希望聊天日志显示 Minecraft 服务器名称，请输入；否则留空。"
      : "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
    minecraftTokenMessage: zh
      ? "如果需要，请输入 QueQiao access token；否则留空。"
      : "Enter the QueQiao access token if required. Leave blank otherwise.",
    minecraftDetail: (url: string) =>
      zh
        ? `Chat bridge 模式：ws · 端点：${url}`
        : `Chat bridge mode: ws · endpoint: ${url}`,
    buildInstallSafetyBoundaryText() {
      return [
        zh ? "Rin 安全边界：" : "Rin safety boundary:",
        zh ? "- Rin 始终运行在 YOLO 模式。" : "- Rin always runs in YOLO mode.",
        zh
          ? "- shell / 文件操作没有沙箱。"
          : "- There is no sandbox for shell/file actions.",
        zh
          ? "- Rin 将以所选系统账号的完整用户级权限运行。"
          : "- Rin acts with the full user-level permissions of the selected system account.",
        zh
          ? "- 它可能读取文件、修改文件、执行命令，并访问该账号可用的网络资源。"
          : "- It may read files, modify files, run commands, and access network resources available to that account.",
        zh
          ? "- 提示词、工具输出、文件内容、记忆上下文与搜索结果可能会发送给当前模型/提供商，因此敏感数据可能暴露。"
          : "- Prompts, tool outputs, file contents, memory context, and search results may be sent to the active model/provider, so sensitive data may be exposed.",
        "",
        zh
          ? "除可见聊天轮次外，可能产生额外 Token 开销："
          : "Possible extra token overhead beyond your visible chat turns:",
        zh
          ? "- 正常轮次中注入的记忆提示块"
          : "- memory prompt blocks injected into normal turns",
        zh
          ? "- 首次运行的 /init 引导对话"
          : "- the first-run /init onboarding conversation",
        zh
          ? "- 会话关闭或 `/new` 交接时的记忆提取"
          : "- memory extraction during session shutdown or `/new` handoff",
        zh
          ? "- 会话关闭或 `/new` 交接时的 episode 综合"
          : "- episode synthesis during session shutdown or `/new` handoff",
        zh
          ? "- 会话上下文过大时的压缩 / 总结"
          : "- context compaction / summarization when the session grows large",
        zh
          ? "- assistant 主动选择或按要求委派的 subagent 运行"
          : "- subagent runs when the assistant chooses or is asked to delegate work",
        zh
          ? "- scheduled task / chat-bridge 触发的 agent 运行"
          : "- scheduled task / chat-bridge-triggered agent runs that create their own turns",
        zh
          ? "- 使用 web search 时加入模型上下文的搜索结果文本"
          : "- web-search result text added into the model context when search is used",
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
      return [
        `${zh ? "目标守护进程用户" : "Target daemon user"}: ${options.targetUser}`,
        `${zh ? "安装目录" : "Install dir"}: ${options.installDir}`,
        `${zh ? "语言" : "Language"}: ${options.language}`,
        `${zh ? "提供商" : "Provider"}: ${options.provider || (zh ? "暂不设置" : "skipped for now")}`,
        `${zh ? "模型" : "Model"}: ${options.modelId || (zh ? "暂不设置" : "skipped for now")}`,
        `${zh ? "思考强度" : "Thinking level"}: ${options.thinkingLevel || (zh ? "暂不设置" : "skipped for now")}`,
        `${zh ? "模型认证状态" : "Model auth status"}: ${options.provider ? (options.authAvailable ? (zh ? "已就绪" : "ready") : zh ? "稍后需要认证/配置" : "needs auth/config later") : zh ? "暂不设置" : "skipped for now"}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
        `${zh ? "Chat bridge" : "Chat bridge"}: ${options.chatDescription}`,
        options.chatDetail,
        options.chatDescription === (zh ? "暂不启用" : "disabled for now")
          ? ""
          : zh
            ? "Chat 授权：安装流程会一次性引导首次 OWNER 设置；后续角色变更应通过自然语言对话提出，不使用 slash command。"
            : "Chat authorization: installer guidance covers the first OWNER setup once; later role changes should be requested in normal conversation, not slash commands.",
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
        zh ? "初始化 TUI 已退出。" : "Initialization TUI exited.",
        "",
        zh ? "下次可用：" : "Next time:",
        `${zh ? "- 打开 Rin" : "- open Rin"}: rin${userSuffix}`,
        `${zh ? "- 如有需要，检查守护进程状态" : "- check daemon state if needed"}: rin doctor${userSuffix}`,
        zh
          ? "- 在 Rin 内通过 `/init` 重新开始引导"
          : "- restart onboarding from inside Rin with `/init`",
      ].join("\n");
    },
    buildFinalRequirements(options: {
      installServiceNow: boolean;
      needsElevatedWrite: boolean;
      needsElevatedService: boolean;
    }) {
      return [
        zh ? "写入配置与启动器" : "write configuration and launchers",
        zh
          ? "将运行时发布到安装目录"
          : "publish the runtime into the install directory",
        options.installServiceNow
          ? zh
            ? "安装并启动守护进程服务"
            : "install and start the daemon service"
          : zh
            ? "在此平台上跳过守护进程服务安装"
            : "skip daemon service installation on this platform",
        options.needsElevatedWrite || options.needsElevatedService
          ? zh
            ? "如目标用户或安装目录需要，请使用 sudo/doas"
            : "use sudo/doas if needed for the selected target and install dir"
          : zh
            ? "当前预计不需要额外提权"
            : "no extra privilege escalation currently predicted",
      ];
    },
    finalizeInstallationMessage(finalRequirements: string[]) {
      return [
        zh ? "现在完成安装吗？" : "Finalize installation now?",
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n");
    },
    noEligibleUsersText(currentUser: string, visibleUsers: string[]) {
      return [
        zh
          ? "在当前系统上未找到可选的现有用户。"
          : "No eligible existing users were found on this system.",
        `${zh ? "检测到的当前用户" : "Detected current user"}: ${currentUser}`,
        `${zh ? "可见用户" : "Visible users"}: ${visibleUsers.join(", ") || (zh ? "无" : "none")}`,
      ].join("\n");
    },
    nothingInstalled: zh ? "未执行安装。" : "Nothing installed.",
    installerFinishedWithoutWritingChanges: zh
      ? "安装器结束，未写入变更。"
      : "Installer finished without writing changes.",
    ownershipMismatchText(ownership: {
      statUid: number;
      statGid: number;
      targetUid: number;
      targetGid: number;
    }) {
      return [
        `${zh ? "目标目录 owner uid/gid" : "Target dir owner uid/gid"}: ${ownership.statUid}:${ownership.statGid}`,
        `${zh ? "目标用户 uid/gid" : "Target user uid/gid"}: ${ownership.targetUid}:${ownership.targetGid}`,
        zh
          ? "该目录当前并不归所选目标用户所有。"
          : "This directory is not currently owned by the selected target user.",
        zh
          ? "如果安装器有权限，它仍会继续写入配置，但在完全切换前你可能需要先修复所有权。"
          : "The installer will still write config if it can, but you may want to fix ownership before switching fully.",
      ].join("\n");
    },
    ownershipNotWritableText: zh
      ? "当前安装器进程对所选安装目录没有写权限。"
      : "The selected install directory is not writable by the current installer process.",
    publishingRuntimeMessageElevated: zh
      ? "正在以提权方式发布运行时并写入配置……"
      : "Publishing runtime and writing configuration with elevated permissions...",
    publishingRuntimeMessage: zh
      ? "正在发布运行时并写入配置……"
      : "Publishing runtime and writing configuration...",
    launchingInitText: zh
      ? [
          "安装已完成。Rin 现在将打开初始化 TUI。",
          "你可以随时退出；安装器随后会打印下一步提示。",
        ].join("\n")
      : [
          "Installation is done. Rin will now open an initialization TUI.",
          "You can exit it anytime; the installer will print the next-step reminder afterwards.",
        ].join("\n"),
    outroInstalled(targetUser: string, installedServiceKind?: string) {
      if (zh) {
        return `已为 ${targetUser} 写入安装配置。${installedServiceKind ? `（已安装 ${installedServiceKind} 服务。）` : ""}`;
      }
      return `Installer wrote config for ${targetUser}.${installedServiceKind ? ` (${installedServiceKind} service installed).` : ""}`;
    },
    installStepFailed: zh ? "安装步骤失败。" : "Install step failed.",
    installStepComplete: zh ? "安装步骤完成。" : "Install step complete.",
    startingLogin(providerName: string) {
      return zh
        ? `正在启动 ${providerName} 登录……`
        : `Starting ${providerName} login...`;
    },
    openUrlToContinueLogin(url: string, instructions?: string) {
      return zh
        ? `打开以下链接以继续登录：\n${url}${instructions ? `\n${instructions}` : ""}`
        : `Open this URL to continue login:\n${url}${instructions ? `\n${instructions}` : ""}`;
    },
    enterLoginValueMessage: zh ? "输入登录所需的值。" : "Enter login value.",
    waitingForLogin(providerName: string) {
      return zh
        ? `正在等待 ${providerName} 登录……`
        : `Waiting for ${providerName} login...`;
    },
    manualCodeInputMessage: zh
      ? "粘贴浏览器中的回调 URL 或验证码。"
      : "Paste the redirect URL or code from the browser.",
    manualCodePlaceholder(lastAuthUrl: string) {
      if (zh) {
        return lastAuthUrl ? "粘贴最终回调 URL 或设备验证码" : "粘贴验证码";
      }
      return lastAuthUrl
        ? "paste the final redirect URL or device code"
        : "paste the code";
    },
    loginComplete(providerName: string) {
      return zh
        ? `${providerName} 登录完成。`
        : `${providerName} login complete.`;
    },
    loginFailed(providerName: string) {
      return zh
        ? `${providerName} 登录失败。`
        : `Login failed for ${providerName}.`;
    },
    enterApiKeyMessage(providerName: string) {
      return zh
        ? `输入 ${providerName} 的 API key 或 token。`
        : `Enter the API key or token for ${providerName}.`;
    },
    tokenRequired: zh ? "Token 不能为空。" : "A token is required.",
  };
}
