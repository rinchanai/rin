import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";

type SlashCommandEntry = {
  name: string;
  description: string;
  source: string;
  sourceInfo?: unknown;
};

type SlashCommandSourceGroup = {
  commands: any[];
  source: string;
};

type RuntimeSlashCommandCollectionOptions = {
  includeBuiltin?: boolean;
  extensionCommands?: any[];
  builtinModuleCommands?: any[];
  promptTemplates?: any[];
  skills?: any[];
};

function trimText(value: unknown) {
  return String(value ?? "").trim();
}

function createSlashCommandEntry(
  name: unknown,
  description: unknown,
  source: string,
  sourceInfo?: unknown,
): SlashCommandEntry {
  const entry: SlashCommandEntry = {
    name: trimText(name),
    description: trimText(description),
    source,
  };
  if (sourceInfo !== undefined) entry.sourceInfo = sourceInfo;
  return entry;
}

export function dedupeSlashCommands(commands: SlashCommandEntry[]) {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const name = trimText(command?.name);
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function getBuiltinSlashCommands() {
  return BUILTIN_SLASH_COMMANDS.map((command) =>
    createSlashCommandEntry(command?.name, command?.description, "builtin"),
  ).filter((command) => command.name);
}

export function getExtensionSlashCommands(commands: any[], source: string) {
  return commands
    .map((command) =>
      createSlashCommandEntry(
        command?.invocationName ?? command?.name,
        command?.description,
        source,
        command?.sourceInfo,
      ),
    )
    .filter((command) => command.name);
}

export function getPromptSlashCommands(templates: any[]) {
  return templates
    .map((template) =>
      createSlashCommandEntry(
        template?.name,
        template?.description,
        "prompt",
        template?.sourceInfo,
      ),
    )
    .filter((command) => command.name);
}

export function getSkillSlashCommands(skills: any[]) {
  return skills
    .map((skill) =>
      createSlashCommandEntry(
        `skill:${trimText(skill?.name)}`,
        skill?.description,
        "skill",
        skill?.sourceInfo,
      ),
    )
    .filter((command) => command.name !== "skill:");
}

function collectSlashCommandSourceGroups(groups: SlashCommandSourceGroup[]) {
  return groups.flatMap(({ commands, source }) =>
    getExtensionSlashCommands(commands, source),
  );
}

export function collectSlashCommands(
  options: {
    includeBuiltin?: boolean;
    commandGroups?: SlashCommandSourceGroup[];
    promptTemplates?: any[];
    skills?: any[];
  } = {},
) {
  return dedupeSlashCommands([
    ...(options.includeBuiltin === false ? [] : getBuiltinSlashCommands()),
    ...collectSlashCommandSourceGroups(options.commandGroups ?? []),
    ...getPromptSlashCommands(options.promptTemplates ?? []),
    ...getSkillSlashCommands(options.skills ?? []),
  ]);
}

function getRuntimeSlashCommandSourceGroups(
  options: RuntimeSlashCommandCollectionOptions,
) {
  return [
    {
      commands: options.extensionCommands ?? [],
      source: "extension",
    },
    {
      commands: options.builtinModuleCommands ?? [],
      source: "builtin_module",
    },
  ].filter(({ commands }) => commands.length > 0);
}

export function collectRuntimeSlashCommands(
  options: RuntimeSlashCommandCollectionOptions = {},
) {
  return collectSlashCommands({
    includeBuiltin: options.includeBuiltin,
    commandGroups: getRuntimeSlashCommandSourceGroups(options),
    promptTemplates: options.promptTemplates ?? [],
    skills: options.skills ?? [],
  });
}

export function getSessionSlashCommands(session: any) {
  return collectRuntimeSlashCommands({
    extensionCommands: session.extensionRunner?.getRegisteredCommands?.() ?? [],
    promptTemplates: session.promptTemplates ?? [],
    skills: session.resourceLoader?.getSkills?.().skills ?? [],
  });
}

export function getOAuthStateFromStorage(authStorage: any) {
  const credentials = Object.fromEntries(
    (authStorage?.list?.() ?? []).map((providerId: string) => {
      const credential = authStorage.get(providerId);
      return [providerId, credential ? { type: credential.type } : undefined];
    }),
  );
  const providers = (authStorage?.getOAuthProviders?.() ?? []).map(
    (provider: any) => ({
      id: provider.id,
      name: provider.name,
      usesCallbackServer: Boolean(provider.usesCallbackServer),
    }),
  );
  return { credentials, providers };
}

export function getSessionOAuthState(session: any) {
  return getOAuthStateFromStorage(session?.modelRegistry?.authStorage);
}
