import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";

type SlashCommandEntry = {
  name: string;
  description: string;
  source: string;
  sourceInfo?: unknown;
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

type SlashCommandSourceGroup = {
  commands: any[];
  source: string;
};

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
