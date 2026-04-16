import {
  BuiltinModuleHost,
  CompositeBuiltinRunner,
} from "./host.js";

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function hasExtensionBindings(session: any) {
  return Boolean(
    session?._extensionUIContext ||
      session?._extensionCommandContextActions ||
      session?._extensionShutdownHandler ||
      session?._extensionErrorListener,
  );
}

function bindBuiltinHostToSession(host: BuiltinModuleHost, session: any) {
  host.bindCore(
    {
      sendMessage: (message, options) => {
        session.sendCustomMessage?.(message, options).catch?.(() => {});
      },
      sendUserMessage: (content, options) => {
        session.sendUserMessage?.(content, options).catch?.(() => {});
      },
      appendEntry: (customType, data) => {
        session.sessionManager?.appendCustomEntry?.(customType, data);
      },
      setSessionName: (name) => {
        session.sessionManager?.appendSessionInfo?.(name);
      },
      getSessionName: () => session.sessionManager?.getSessionName?.(),
      setLabel: (entryId, label) => {
        session.sessionManager?.appendLabelChange?.(entryId, label);
      },
      getActiveTools: () => session.getActiveToolNames?.() || [],
      getAllTools: () => session.getAllTools?.() || [],
      setActiveTools: (toolNames) => session.setActiveToolsByName?.(toolNames),
      refreshTools: () => session._refreshToolRegistry?.(),
      getCommands: () => [],
      setModel: async (model) => {
        if (!session.modelRegistry?.hasConfiguredAuth?.(model)) return false;
        await session.setModel?.(model);
        return true;
      },
      getThinkingLevel: () => session.thinkingLevel,
      setThinkingLevel: (level) => session.setThinkingLevel?.(level),
    },
    {
      getModel: () => session.model,
      isIdle: () => !session.isStreaming,
      getSignal: () => session.agent?.signal,
      abort: () => {
        void session.abort?.().catch?.(() => {});
      },
      hasPendingMessages: () => session.pendingMessageCount > 0,
      shutdown: () => {
        session._extensionShutdownHandler?.();
      },
      getContextUsage: () => session.getContextUsage?.(),
      compact: (options) => {
        void (async () => {
          try {
            const result = await session.compact?.(options?.customInstructions);
            options?.onComplete?.(result);
          } catch (error: any) {
            options?.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
      getSystemPrompt: () => session.systemPrompt,
    },
  );
  host.setUIContext(session._extensionUIContext);
  host.bindCommandContext(session._extensionCommandContextActions);
}

async function emitBuiltinSessionStart(host: BuiltinModuleHost, reason: SessionStartReason, previousSessionFile?: string) {
  if (!host.hasHandlers("session_start")) return;
  await host.emit({
    type: "session_start",
    reason,
    previousSessionFile,
  });
}

export async function attachBuiltinModulesToSession(
  session: any,
  options: {
    cwd: string;
    agentDir: string;
    disabledNames?: string[];
    reason?: SessionStartReason;
    previousSessionFile?: string;
  },
) {
  const host = await BuiltinModuleHost.create({
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: session.sessionManager,
    modelRegistry: session.modelRegistry,
    disabledNames: options.disabledNames,
  });
  bindBuiltinHostToSession(host, session);

  const externalRunner = session._extensionRunner;
  const compositeRunner = new CompositeBuiltinRunner(externalRunner, host);
  compositeRunner.setUIContext(session._extensionUIContext);
  compositeRunner.bindCommandContext(session._extensionCommandContextActions);
  if (session._extensionErrorListener) {
    compositeRunner.onError(session._extensionErrorListener);
  }
  session._extensionRunner = compositeRunner;

  if (
    options.reason &&
    options.reason !== "reload" &&
    hasExtensionBindings(session)
  ) {
    await emitBuiltinSessionStart(host, options.reason, options.previousSessionFile);
  }

  if (session.__rinBuiltinCapabilitiesPatched) {
    return { host, compositeRunner };
  }
  session.__rinBuiltinCapabilitiesPatched = true;

  const originalReload =
    typeof session.reload === "function" ? session.reload.bind(session) : null;
  if (originalReload) {
    session.reload = async (...args: any[]) => {
      const result = await originalReload(...args);
      const reattached = await attachBuiltinModulesToSession(session, {
        cwd: options.cwd,
        agentDir: options.agentDir,
        disabledNames: options.disabledNames,
        reason: "reload",
      });
      if (hasExtensionBindings(session)) {
        await emitBuiltinSessionStart(reattached.host, "reload");
      }
      return result;
    };
  }

  return { host, compositeRunner };
}
