import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";

type SlashCommandEntry = {
  name: string;
  description: string;
  source: string;
  sourceInfo?: unknown;
};

type SlashCommandSourceGroup = {
  commands: unknown[];
  source: string;
};

type RuntimeSlashCommandCollectionOptions = {
  includeBuiltin?: boolean;
  extensionCommands?: unknown[];
  builtinModuleCommands?: unknown[];
  promptTemplates?: unknown[];
  skills?: unknown[];
};

type OAuthCredentialSummary = {
  type: string;
};

type OAuthProviderSummary = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
};

type SlashCommandCollectorSpec<T> = {
  source: unknown;
  getName: (value: T) => unknown;
  getDescription?: (value: T) => unknown;
  getSourceInfo?: (value: T) => unknown;
};

function trimText(value: unknown) {
  return String(value ?? "").trim();
}

function asArray<T>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
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
  values: unknown,
  mapValue: (value: T) => SlashCommandEntry | null,
) {
  const commands: SlashCommandEntry[] = [];
  for (const value of asArray<T>(values)) {
    const command = mapValue(value);
    if (command) commands.push(command);
  }
  return commands;
}

function collectSlashCommandsForSource<T>(
  values: unknown,
  spec: SlashCommandCollectorSpec<T>,
) {
  const source = trimText(spec.source);
  if (!source) return [];
  return collectSlashCommandEntries<T>(values, (value) =>
    createSlashCommandEntry(
      spec.getName(value),
      spec.getDescription?.(value),
      source,
      spec.getSourceInfo?.(value),
    ),
  );
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
  return collectSlashCommandsForSource<any>(BUILTIN_SLASH_COMMANDS, {
    source: "builtin",
    getName: (command) => command?.name,
    getDescription: (command) => command?.description,
  });
}

export function getExtensionSlashCommands(commands: unknown[], source: string) {
  return collectSlashCommandsForSource<any>(commands, {
    source,
    getName: (command) => command?.invocationName ?? command?.name,
    getDescription: (command) => command?.description,
    getSourceInfo: (command) => command?.sourceInfo,
  });
}

export function getPromptSlashCommands(templates: unknown[]) {
  return collectSlashCommandsForSource<any>(templates, {
    source: "prompt",
    getName: (template) => template?.name,
    getDescription: (template) => template?.description,
    getSourceInfo: (template) => template?.sourceInfo,
  });
}

export function getSkillSlashCommands(skills: unknown[]) {
  return collectSlashCommandsForSource<any>(skills, {
    source: "skill",
    getName: getSkillSlashCommandName,
    getDescription: (skill) => skill?.description,
    getSourceInfo: (skill) => skill?.sourceInfo,
  });
}

function collectSlashCommandSourceGroups(groups: unknown) {
  return asArray<SlashCommandSourceGroup>(groups).flatMap((group) =>
    getExtensionSlashCommands(group?.commands ?? [], group?.source),
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

const RUNTIME_SLASH_COMMAND_GROUP_DEFINITIONS = [
  { key: "extensionCommands", source: "extension" },
  { key: "builtinModuleCommands", source: "builtin_module" },
] as const satisfies Array<{
  key: keyof Pick<
    RuntimeSlashCommandCollectionOptions,
    "extensionCommands" | "builtinModuleCommands"
  >;
  source: string;
}>;

function getRuntimeSlashCommandSourceGroups(
  options: RuntimeSlashCommandCollectionOptions,
) {
  return RUNTIME_SLASH_COMMAND_GROUP_DEFINITIONS.flatMap(({ key, source }) => {
    const commands = asArray(options[key]);
    return commands.length ? [{ commands, source }] : [];
  });
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

function getSessionSkills(session: any) {
  return asArray(session?.resourceLoader?.getSkills?.()?.skills);
}

export function getSessionSlashCommands(session: any) {
  return collectRuntimeSlashCommands({
    extensionCommands: session?.extensionRunner?.getRegisteredCommands?.() ?? [],
    promptTemplates: asArray(session?.promptTemplates),
    skills: getSessionSkills(session),
  });
}

function normalizeOAuthCredentialType(value: unknown) {
  return trimText(value);
}

function buildOAuthCredentialSummary(
  credential: any,
): OAuthCredentialSummary | undefined {
  const type = normalizeOAuthCredentialType(credential?.type);
  return type ? { type } : undefined;
}

function normalizeProviderId(value: unknown) {
  return trimText(value);
}

function normalizeOAuthProvider(provider: any): OAuthProviderSummary | null {
  const id = normalizeProviderId(provider?.id);
  if (!id) return null;
  return {
    id,
    name: trimText(provider?.name),
    usesCallbackServer: Boolean(provider?.usesCallbackServer),
  };
}

export function getOAuthStateFromStorage(authStorage: any) {
  const credentials: Record<string, OAuthCredentialSummary | undefined> = {};
  for (const providerId of asArray<string>(authStorage?.list?.())) {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId || normalizedProviderId in credentials) continue;
    credentials[normalizedProviderId] = buildOAuthCredentialSummary(
      authStorage?.get?.(providerId),
    );
  }

  const providers: OAuthProviderSummary[] = [];
  const seenProviderIds = new Set<string>();
  for (const provider of asArray(authStorage?.getOAuthProviders?.())) {
    const normalizedProvider = normalizeOAuthProvider(provider);
    if (!normalizedProvider) continue;
    if (seenProviderIds.has(normalizedProvider.id)) continue;
    seenProviderIds.add(normalizedProvider.id);
    providers.push(normalizedProvider);
  }

  return { credentials, providers };
}

export function getSessionOAuthState(session: any) {
  return getOAuthStateFromStorage(session?.modelRegistry?.authStorage);
}
