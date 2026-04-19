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
): SlashCommandEntry | null {
  const trimmedName = trimText(name);
  if (!trimmedName) return null;
  const entry: SlashCommandEntry = {
    name: trimmedName,
    description: trimText(description),
    source,
  };
  if (sourceInfo !== undefined) entry.sourceInfo = sourceInfo;
  return entry;
}

function collectSlashCommandEntries<T>(
  values: T[],
  mapValue: (value: T) => SlashCommandEntry | null,
) {
  const commands: SlashCommandEntry[] = [];
  for (const value of values) {
    const command = mapValue(value);
    if (command) commands.push(command);
  }
  return commands;
}

function getSkillSlashCommandName(skill: any) {
  const name = trimText(skill?.name);
  return name ? `skill:${name}` : "";
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
  return collectSlashCommandEntries(BUILTIN_SLASH_COMMANDS, (command) =>
    createSlashCommandEntry(command?.name, command?.description, "builtin"),
  );
}

export function getExtensionSlashCommands(commands: any[], source: string) {
  return collectSlashCommandEntries(commands, (command) =>
    createSlashCommandEntry(
      command?.invocationName ?? command?.name,
      command?.description,
      source,
      command?.sourceInfo,
    ),
  );
}

export function getPromptSlashCommands(templates: any[]) {
  return collectSlashCommandEntries(templates, (template) =>
    createSlashCommandEntry(
      template?.name,
      template?.description,
      "prompt",
      template?.sourceInfo,
    ),
  );
}

export function getSkillSlashCommands(skills: any[]) {
  return collectSlashCommandEntries(skills, (skill) =>
    createSlashCommandEntry(
      getSkillSlashCommandName(skill),
      skill?.description,
      "skill",
      skill?.sourceInfo,
    ),
  );
}

function collectSlashCommandSourceGroups(groups: SlashCommandSourceGroup[]) {
  const commands: SlashCommandEntry[] = [];
  for (const { commands: groupCommands, source } of groups) {
    commands.push(...getExtensionSlashCommands(groupCommands, source));
  }
  return commands;
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
  const groups: SlashCommandSourceGroup[] = [];
  if (options.extensionCommands?.length) {
    groups.push({
      commands: options.extensionCommands,
      source: "extension",
    });
  }
  if (options.builtinModuleCommands?.length) {
    groups.push({
      commands: options.builtinModuleCommands,
      source: "builtin_module",
    });
  }
  return groups;
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
