import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import {
  BuiltinModuleHost,
  CompositeBuiltinRunner,
} from "../builtins/host.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { extractText } from "./session-helpers.js";

export async function loadRpcLocalExtensions(
  target: any,
  forceReload: boolean,
  runtimeProfile: { cwd: string; agentDir: string },
) {
  const codingAgentModule: any = await loadRinCodingAgent();
  const { createEventBus, discoverAndLoadExtensions, ExtensionRunner } =
    codingAgentModule;

  const eventBus = createEventBus();
  const result = await discoverAndLoadExtensions(
    target.additionalExtensionPaths,
    runtimeProfile.cwd,
    runtimeProfile.agentDir,
    eventBus,
  );

  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    runtimeProfile.cwd,
    target.sessionManager,
    target.modelRegistry,
  );

  runner.bindCore(
    {
      sendMessage: (message: string, options?: { images?: any[] }) => {
        void target
          .prompt(message, {
            images: options?.images,
            source: "extension" as any,
          })
          .catch(() => {});
      },
      sendUserMessage: (content: any) => {
        const text = extractText(content);
        if (!text) return;
        void target
          .prompt(text, { source: "extension" as any })
          .catch(() => {});
      },
      appendEntry: () => {},
      setSessionName: (name: string) => {
        void target.setSessionName(name).catch(() => {});
      },
      getSessionName: () => target.sessionName,
      setLabel: (entryId: string, label: string | undefined) => {
        void target.setEntryLabel(entryId, label).catch(() => {});
      },
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => runner.getRegisteredCommands(),
      setModel: async (model: any) => {
        await target.setModel(model);
      },
      getThinkingLevel: () => target.thinkingLevel,
      setThinkingLevel: (level: ThinkingLevel) => {
        target.setThinkingLevel(level);
      },
    },
    {
      getModel: () => target.model,
      isIdle: () =>
        (target.getFrontendStatusEvent?.()?.phase || "idle") === "idle",
      getSignal: () => undefined,
      abort: () => {
        void target.abort().catch(() => {});
      },
      hasPendingMessages: () => target.pendingMessageCount > 0,
      shutdown: () => target.extensionBindings.shutdownHandler?.(),
      getContextUsage: () => target.getContextUsage(),
      compact: (options?: { customInstructions?: string }) => {
        void target.compact(options?.customInstructions).catch(() => {});
      },
      getSystemPrompt: () => target.systemPrompt,
    },
  );

  const builtinHost = await BuiltinModuleHost.create({
    cwd: runtimeProfile.cwd,
    agentDir: runtimeProfile.agentDir,
    sessionManager: target.sessionManager,
    modelRegistry: target.modelRegistry,
  });
  builtinHost.bindCore(
    {
      sendMessage: (message: string, options?: { images?: any[] }) => {
        void target
          .prompt(message, {
            images: options?.images,
            source: "extension" as any,
          })
          .catch(() => {});
      },
      sendUserMessage: (content: any) => {
        const text = extractText(content);
        if (!text) return;
        void target
          .prompt(text, { source: "extension" as any })
          .catch(() => {});
      },
      appendEntry: () => {},
      setSessionName: (name: string) => {
        void target.setSessionName(name).catch(() => {});
      },
      getSessionName: () => target.sessionName,
      setLabel: (entryId: string, label: string | undefined) => {
        void target.setEntryLabel(entryId, label).catch(() => {});
      },
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async (model: any) => {
        await target.setModel(model);
        return true;
      },
      getThinkingLevel: () => target.thinkingLevel,
      setThinkingLevel: (level: ThinkingLevel) => {
        target.setThinkingLevel(level);
      },
    },
    {
      getModel: () => target.model,
      isIdle: () =>
        (target.getFrontendStatusEvent?.()?.phase || "idle") === "idle",
      getSignal: () => undefined,
      abort: () => {
        void target.abort().catch(() => {});
      },
      hasPendingMessages: () => target.pendingMessageCount > 0,
      shutdown: () => target.extensionBindings.shutdownHandler?.(),
      getContextUsage: () => target.getContextUsage(),
      compact: (options?: { customInstructions?: string }) => {
        void target.compact(options?.customInstructions).catch(() => {});
      },
      getSystemPrompt: () => target.systemPrompt,
    },
  );

  const compositeRunner = new CompositeBuiltinRunner(runner, builtinHost);
  compositeRunner.setUIContext(target.extensionBindings.uiContext);
  compositeRunner.bindCommandContext(target.extensionBindings.commandContextActions);
  if (target.extensionBindings.onError)
    compositeRunner.onError(target.extensionBindings.onError);

  target.extensionRunner = compositeRunner;
  if (forceReload || result.extensions.length > 0 || builtinHost.getRegisteredCommands().length > 0) {
    await compositeRunner.emit({
      type: "session_start",
      reason: forceReload ? "reload" : "startup",
    });
  }
}
