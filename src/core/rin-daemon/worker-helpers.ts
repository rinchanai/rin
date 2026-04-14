import { loadRinChangelogModule } from "../rin-lib/loader.js";
import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";

export function writeJsonLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function getSessionState(session: any) {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  };
}

export function getSlashCommands(
  session: any,
  builtinSlashCommands: any[] = BUILTIN_SLASH_COMMANDS,
) {
  const commands: any[] = [];
  for (const command of builtinSlashCommands) {
    commands.push({
      name: command.name,
      description: command.description,
      source: "builtin",
    });
  }
  for (const command of session.extensionRunner?.getRegisteredCommands?.() ??
    []) {
    commands.push({
      name: command.invocationName,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }
  for (const template of session.promptTemplates ?? []) {
    commands.push({
      name: template.name,
      description: template.description,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }
  for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }
  return commands;
}

export function getOAuthState(session: any) {
  const authStorage = session.modelRegistry.authStorage;
  const credentials = Object.fromEntries(
    authStorage.list().map((providerId: string) => {
      const credential = authStorage.get(providerId);
      return [providerId, credential ? { type: credential.type } : undefined];
    }),
  );
  const providers = authStorage.getOAuthProviders().map((provider: any) => ({
    id: provider.id,
    name: provider.name,
    usesCallbackServer: Boolean(provider.usesCallbackServer),
  }));
  return { credentials, providers };
}

export function splitCommandArgs(text: string) {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of String(text || "")) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export function formatSessionStats(stats: any) {
  return [
    `Session ID: ${String(stats?.sessionId || "")}`,
    `Session File: ${String(stats?.sessionFile || "In-memory")}`,
    `Messages: ${String(stats?.totalMessages || 0)} (user=${String(stats?.userMessages || 0)}, assistant=${String(stats?.assistantMessages || 0)}, toolResults=${String(stats?.toolResults || 0)})`,
    `Tool Calls: ${String(stats?.toolCalls || 0)}`,
    `Tokens: ${String(stats?.tokens?.total || 0)} (input=${String(stats?.tokens?.input || 0)}, output=${String(stats?.tokens?.output || 0)}, cacheRead=${String(stats?.tokens?.cacheRead || 0)}, cacheWrite=${String(stats?.tokens?.cacheWrite || 0)})`,
    `Cost: ${String(stats?.cost || 0)}`,
  ].join("\n");
}

export async function runBuiltinCommand(
  runtime: any,
  commandLine: string,
  deps: { SessionManager: any },
) {
  const session = runtime.session;
  const trimmed = String(commandLine || "").trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const [name = "", ...rest] = splitCommandArgs(trimmed.slice(1));
  const argsText = rest.join(" ").trim();
  const command = name.trim();
  if (!command) return { handled: false };

  switch (command) {
    case "abort":
      await session.abort();
      return { handled: true, text: "Aborted current operation." };
    case "new":
      await runtime.newSession();
      return { handled: true, text: "Started a new session." };
    case "compact":
      await session.compact(argsText || undefined);
      return { handled: true, text: "Compacted session." };
    case "reload":
      await session.reload();
      return {
        handled: true,
        text: "Reloaded extensions, prompts, skills, and themes.",
      };
    case "session":
      return {
        handled: true,
        text: formatSessionStats(session.getSessionStats()),
      };
    case "changelog": {
      const { getChangelogPath, parseChangelog }: any =
        await loadRinChangelogModule();
      const changelogPath = getChangelogPath();
      const entries = parseChangelog(changelogPath);
      if (entries.length === 0) {
        return {
          handled: true,
          text: "No changelog entries found.",
        };
      }
      return {
        handled: true,
        text: entries
          .slice()
          .reverse()
          .map((entry: any) => String(entry?.content || "").trim())
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    case "resume": {
      const sessions = await deps.SessionManager.listAll();
      if (!argsText) {
        const lines = sessions.slice(0, 20).map((item: any) => {
          const label =
            String(item?.name || item?.id || "").trim() ||
            String(item?.id || "");
          return `${String(item?.id || "")} — ${label}`;
        });
        return {
          handled: true,
          text: lines.length
            ? ["Available sessions:", ...lines].join("\n")
            : "No sessions available.",
        };
      }
      const match = sessions.find(
        (item: any) => String(item?.id || "") === argsText,
      );
      if (!match)
        return { handled: true, text: `Session not found: ${argsText}` };
      await runtime.switchSession(String(match.path || ""));
      return {
        handled: true,
        text: `Resumed session: ${String(match.id || "")}`,
      };
    }
    case "model": {
      if (!rest.length) {
        const models = await session.modelRegistry.getAvailable();
        const lines = models
          .slice(0, 50)
          .map(
            (model: any) =>
              `${String(model.provider || "")}/${String(model.id || "")}`,
          );
        return {
          handled: true,
          text: lines.length
            ? ["Available models:", ...lines].join("\n")
            : "No models available.",
        };
      }
      const [targetRef = "", thinkingLevel = ""] = rest;
      const [provider = "", modelId = ""] = String(targetRef).split("/", 2);
      if (!provider || !modelId)
        return {
          handled: true,
          text: "Usage: /model <provider/model> [thinking-level]",
        };
      const models = await session.modelRegistry.getAvailable();
      const match = models.find(
        (model: any) => model.provider === provider && model.id === modelId,
      );
      if (!match)
        return { handled: true, text: `Model not found: ${targetRef}` };
      await session.setModel(match);
      if (thinkingLevel) await session.setThinkingLevel(thinkingLevel);
      return {
        handled: true,
        text: `Model set to: ${provider}/${modelId}${thinkingLevel ? ` (${thinkingLevel})` : ""}`,
      };
    }
    default: {
      const extensionCommand = session.extensionRunner?.getCommand?.(command);
      if (extensionCommand) {
        await session.prompt(trimmed);
        return {
          handled: true,
          text: `Started command: /${command}`,
        };
      }
      return { handled: false };
    }
  }
}
