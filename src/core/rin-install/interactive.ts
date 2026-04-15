import path from "node:path";

import { promptChatBridgeSetup } from "../chat-bridge/setup.js";
import {
  configureProviderAuth,
  computeAvailableThinkingLevels,
  loadModelChoices,
} from "./provider-auth.js";

export type PromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type SystemUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

export async function promptTargetInstall(
  prompt: PromptApi,
  currentUser: string,
  allUsers: SystemUser[],
  targetHomeForUser: (user: string) => string,
) {
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser);
  const existingCandidates = otherUsers.length
    ? otherUsers
    : allUsers.filter((entry) => entry.name !== currentUser).length
      ? allUsers.filter((entry) => entry.name !== currentUser)
      : allUsers;

  const targetMode = prompt.ensureNotCancelled(
    await prompt.select({
      message: "Choose the target user for the Rin daemon.",
      options: [
        { value: "current", label: "Current user", hint: currentUser },
        {
          value: "existing",
          label: "Existing other user",
          hint: existingCandidates.length
            ? `${existingCandidates.length} user(s)`
            : "none found",
        },
        { value: "new", label: "New user", hint: "enter a username" },
      ],
    }),
  );

  let targetUser = currentUser;
  if (targetMode === "existing") {
    if (!existingCandidates.length) {
      return {
        cancelled: true as const,
        targetUser,
        existingCandidates,
        allUsers,
      };
    }
    targetUser = prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose the existing user to host the Rin daemon.",
        options: existingCandidates.map((entry) => ({
          value: entry.name,
          label: entry.name,
          hint: `${entry.home} · uid ${entry.uid}`,
        })),
      }),
    );
  } else if (targetMode === "new") {
    targetUser = prompt.ensureNotCancelled(
      await prompt.text({
        message: "Enter the new username to create for the Rin daemon.",
        placeholder: "rin",
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return "Username is required.";
          if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next))
            return "Use a normal Unix username.";
        },
      }),
    );
  }

  const defaultDir = path.join(targetHomeForUser(targetUser), ".rin");
  const installDir = String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: "Choose the Rin data directory for the daemon user.",
        placeholder: defaultDir,
        defaultValue: defaultDir,
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return "Directory is required.";
          if (!path.isAbsolute(next)) return "Use an absolute path.";
        },
      }),
    ),
  ).trim();

  return {
    cancelled: false as const,
    targetUser,
    installDir,
    defaultDir,
    existingCandidates,
    allUsers,
  };
}

export function describeInstallDirState(
  installDir: string,
  state: { exists: boolean; entryCount: number; sample: string[] },
) {
  if (state.exists) {
    return {
      title: "Existing directory",
      text: [
        `Directory exists: ${installDir}`,
        `Existing entries: ${state.entryCount}`,
        state.sample.length ? `Sample: ${state.sample.join(", ")}` : "",
        "",
        "Installer policy:",
        "- keep unknown files untouched",
        "- keep existing config unless a required file must be updated",
        "- only remove old files when they are known legacy Rin artifacts",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    title: "Install directory",
    text: [
      `Directory will be created: ${installDir}`,
      "",
      "Installer policy:",
      "- create only the files Rin needs",
      "- future updates should preserve unknown files",
    ].join("\n"),
  };
}

export async function promptProviderSetup(
  prompt: PromptApi,
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const shouldConfigureProvider = prompt.ensureNotCancelled(
    await prompt.confirm({
      message: "Configure a provider now?",
      initialValue: true,
    }),
  );

  let provider = "";
  let modelId = "";
  let thinkingLevel = "";
  let authResult: any = { available: false, authKind: "skipped", authData: {} };

  if (!shouldConfigureProvider)
    return { provider, modelId, thinkingLevel, authResult };

  const models = await loadModelChoices();
  const providerNames = [
    ...new Set(models.map((model) => model.provider).filter(Boolean)),
  ];
  if (!providerNames.length)
    throw new Error("rin_installer_no_models_available");

  provider = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose a provider to authenticate and use.",
        options: providerNames.map((name) => {
          const scoped = models.filter((model) => model.provider === name);
          const availableCount = scoped.filter(
            (model) => model.available,
          ).length;
          return {
            value: name,
            label: name,
            hint: availableCount
              ? `${availableCount}/${scoped.length} ready`
              : `${scoped.length} models`,
          };
        }),
      }),
    ),
  );

  authResult = await configureProviderAuth(String(provider), installDir, {
    readJsonFile,
    ensureNotCancelled: prompt.ensureNotCancelled,
  });

  const providerModels = models.filter((model) => model.provider === provider);
  if (!providerModels.length)
    throw new Error(`rin_installer_no_models_for_provider:${provider}`);
  modelId = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose a model.",
        options: providerModels.map((model) => ({
          value: model.id,
          label: model.id,
          hint: [
            authResult.available || model.available
              ? "ready"
              : "needs auth/config",
            model.reasoning ? "reasoning" : "no reasoning",
          ].join(" · "),
        })),
      }),
    ),
  );

  const model = providerModels.find((entry) => entry.id === modelId)!;
  thinkingLevel = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: "Choose the default thinking level.",
        options: computeAvailableThinkingLevels(model).map((level) => ({
          value: level,
          label: level,
        })),
      }),
    ),
  );

  return { provider, modelId, thinkingLevel, authResult };
}

export async function promptChatSetup(prompt: PromptApi) {
  const result = await promptChatBridgeSetup(prompt);
  return {
    chatDescription: result.chatDescription,
    chatDetail: result.chatDetail,
    chatConfig: result.chatConfig,
  };
}

export function buildInstallSafetyBoundaryText() {
  return [
    "Rin safety boundary:",
    "- Rin always runs in YOLO mode.",
    "- There is no sandbox for shell/file actions.",
    "- Rin acts with the full user-level permissions of the selected system account.",
    "- It may read files, modify files, run commands, and access network resources available to that account.",
    "- Prompts, tool outputs, file contents, memory context, and search results may be sent to the active model/provider, so sensitive data may be exposed.",
    "",
    "Possible extra token overhead beyond your visible chat turns:",
    "- memory prompt blocks injected into normal turns",
    "- the first-run /init onboarding conversation",
    "- memory extraction during session shutdown or `/new` handoff",
    "- episode synthesis during session shutdown or `/new` handoff",
    "- context compaction / summarization when the session grows large",
    "- subagent runs when the assistant chooses or is asked to delegate work",
    "- scheduled task / chat-bridge-triggered agent runs that create their own turns",
    "- web-search result text added into the model context when search is used",
  ].join("\n");
}

export function buildInstallPlanText(options: {
  currentUser: string;
  targetUser: string;
  installDir: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  authAvailable: boolean;
  chatDescription: string;
  chatDetail: string;
}) {
  const {
    currentUser,
    targetUser,
    installDir,
    provider,
    modelId,
    thinkingLevel,
    authAvailable,
    chatDescription,
    chatDetail,
  } = options;
  return [
    `Target daemon user: ${targetUser}`,
    `Install dir: ${installDir}`,
    `Provider: ${provider || "skipped for now"}`,
    `Model: ${modelId || "skipped for now"}`,
    `Thinking level: ${thinkingLevel || "skipped for now"}`,
    `Model auth status: ${provider ? (authAvailable ? "ready" : "needs auth/config later") : "skipped for now"}`,
    `Chat bridge: ${chatDescription}`,
    chatDetail,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPostInstallInitExitText(options: {
  currentUser: string;
  targetUser: string;
}) {
  const userSuffix =
    options.currentUser === options.targetUser
      ? ""
      : ` -u ${options.targetUser}`;
  return [
    "Initialization TUI exited.",
    "",
    "Next time:",
    `- open Rin: rin${userSuffix}`,
    `- check daemon state if needed: rin doctor${userSuffix}`,
    "- restart onboarding from inside Rin with `/init`",
  ].join("\n");
}

export function buildFinalRequirements(options: {
  installServiceNow: boolean;
  needsElevatedWrite: boolean;
  needsElevatedService: boolean;
}) {
  return [
    "write configuration and launchers",
    "publish the runtime into the install directory",
    options.installServiceNow
      ? "install and start the daemon service"
      : "skip daemon service installation on this platform",
    options.needsElevatedWrite || options.needsElevatedService
      ? "use sudo/doas if needed for the selected target and install dir"
      : "no extra privilege escalation currently predicted",
  ];
}
