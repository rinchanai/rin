import { loadRinChangelogModule } from "../rin-lib/loader.js";
import { listBoundSessions } from "../session/factory.js";

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

export {
  getBuiltinSlashCommands,
  getSessionOAuthState as getOAuthState,
  getSessionSlashCommands as getSlashCommands,
} from "./catalog-helpers.js";

export function splitCommandArgs(text: string) {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let tokenStarted = false;
  const pushCurrent = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = "";
    tokenStarted = false;
  };
  for (const char of String(text || "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === " " || char === "\t") {
      pushCurrent();
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  pushCurrent();
  return args;
}

function formatSessionStatsLine(label: string, value: string) {
  return `${label}: ${value}`;
}

export function formatSessionStats(stats: any) {
  return [
    formatSessionStatsLine("Session ID", String(stats?.sessionId || "")),
    formatSessionStatsLine(
      "Session File",
      String(stats?.sessionFile || "In-memory"),
    ),
    formatSessionStatsLine(
      "Messages",
      `${String(stats?.totalMessages || 0)} (user=${String(stats?.userMessages || 0)}, assistant=${String(stats?.assistantMessages || 0)}, toolResults=${String(stats?.toolResults || 0)})`,
    ),
    formatSessionStatsLine("Tool Calls", String(stats?.toolCalls || 0)),
    formatSessionStatsLine(
      "Tokens",
      `${String(stats?.tokens?.total || 0)} (input=${String(stats?.tokens?.input || 0)}, output=${String(stats?.tokens?.output || 0)}, cacheRead=${String(stats?.tokens?.cacheRead || 0)}, cacheWrite=${String(stats?.tokens?.cacheWrite || 0)})`,
    ),
    formatSessionStatsLine("Cost", String(stats?.cost || 0)),
  ].join("\n");
}

function formatBuiltinList(title: string, lines: string[], emptyText: string) {
  return lines.length ? [title, ...lines].join("\n") : emptyText;
}

function formatSessionListItem(item: any) {
  const id = String(item?.id || "").trim();
  const label = String(item?.name || item?.id || "").trim() || id;
  return `${id} — ${label}`;
}

function formatModelRef(model: any) {
  const provider = String(model?.provider || "").trim();
  const id = String(model?.id || "").trim();
  return provider && id ? `${provider}/${id}` : "";
}

function findModelByRef(models: any[], targetRef: string) {
  return models.find((model: any) => formatModelRef(model) === targetRef);
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
      const sessions = await listBoundSessions({
        cwd: session.sessionManager.getCwd(),
        sessionDir: session.sessionManager.getSessionDir(),
        SessionManager: deps.SessionManager,
      });
      if (!argsText) {
        return {
          handled: true,
          text: formatBuiltinList(
            "Available sessions:",
            sessions.slice(0, 20).map(formatSessionListItem),
            "No sessions available.",
          ),
        };
      }
      const match = sessions.find(
        (item: any) => String(item?.id || "").trim() === argsText,
      );
      if (!match) {
        return { handled: true, text: `Session not found: ${argsText}` };
      }
      await runtime.switchSession(String(match.path || ""));
      return {
        handled: true,
        text: `Resumed session: ${String(match.id || "").trim()}`,
      };
    }
    case "model": {
      const models = await session.modelRegistry.getAvailable();
      if (!rest.length) {
        return {
          handled: true,
          text: formatBuiltinList(
            "Available models:",
            models.slice(0, 50).map(formatModelRef).filter(Boolean),
            "No models available.",
          ),
        };
      }
      const [targetRef = "", thinkingLevel = ""] = rest;
      const nextTargetRef = String(targetRef || "").trim();
      if (!nextTargetRef.includes("/")) {
        return {
          handled: true,
          text: "Usage: /model <provider/model> [thinking-level]",
        };
      }
      const match = findModelByRef(models, nextTargetRef);
      if (!match) {
        return { handled: true, text: `Model not found: ${nextTargetRef}` };
      }
      await session.setModel(match);
      if (thinkingLevel) await session.setThinkingLevel(thinkingLevel);
      return {
        handled: true,
        text: `Model set to: ${formatModelRef(match)}${thinkingLevel ? ` (${thinkingLevel})` : ""}`,
      };
    }
    default:
      return { handled: false };
  }
}
