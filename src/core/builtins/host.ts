import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import {
  getBuiltinModuleUrl,
  getBuiltinModuleNames,
  type BuiltinModuleName,
} from "./registry.js";

type EventHandler = (event: any, ctx: any) => Promise<any> | any;
type ErrorListener = (error: any) => void;

type RegisteredTool = {
  definition: any;
  sourcePath: string;
};

type RegisteredCommand = {
  name: string;
  description?: string;
  handler: (args: string, ctx: any) => Promise<void> | void;
  sourcePath: string;
};

type CoreActions = {
  sendMessage: (message: any, options?: any) => void;
  sendUserMessage: (content: any, options?: any) => void;
  appendEntry: (customType: string, data?: unknown) => void;
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
  setLabel: (entryId: string, label: string | undefined) => void;
  getActiveTools: () => string[];
  getAllTools: () => any[];
  setActiveTools: (toolNames: string[]) => void;
  refreshTools: () => void;
  getCommands: () => any[];
  setModel: (model: any) => Promise<boolean>;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
};

type ContextActions = {
  getModel: () => any;
  isIdle: () => boolean;
  getSignal: () => AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => any;
  compact: (options?: any) => void;
  getSystemPrompt: () => string;
};

type CommandContextActions = {
  waitForIdle: () => Promise<void>;
  newSession: (options?: any) => Promise<{ cancelled: boolean }>;
  fork: (entryId: string) => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: any) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

const noOpUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  setEditorComponent: () => {},
};

const noOpCoreActions: CoreActions = {
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getSessionName: () => undefined,
  setLabel: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: () => {},
  refreshTools: () => {},
  getCommands: () => [],
  setModel: async () => false,
  getThinkingLevel: () => "medium",
  setThinkingLevel: () => {},
};

const noOpContextActions: ContextActions = {
  getModel: () => undefined,
  isIdle: () => true,
  getSignal: () => undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "",
};

const noOpCommandContextActions: CommandContextActions = {
  waitForIdle: async () => {},
  newSession: async () => ({ cancelled: false }),
  fork: async () => ({ cancelled: false }),
  navigateTree: async () => ({ cancelled: false }),
  switchSession: async () => ({ cancelled: false }),
  reload: async () => {},
};

export class BuiltinModuleHost {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly toolMap = new Map<string, RegisteredTool>();
  private readonly commands: RegisteredCommand[] = [];
  private uiContext: any = noOpUIContext;
  private coreActions: CoreActions = noOpCoreActions;
  private contextActions: ContextActions = noOpContextActions;
  private commandContextActions: CommandContextActions =
    noOpCommandContextActions;
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(
    public readonly cwd: string,
    public readonly agentDir: string,
    public readonly sessionManager: any,
    public readonly modelRegistry: any,
  ) {}

  static async create(
    options: {
      cwd: string;
      agentDir: string;
      sessionManager?: any;
      modelRegistry?: any;
      disabledNames?: string[];
    },
  ) {
    const host = new BuiltinModuleHost(
      options.cwd,
      options.agentDir,
      options.sessionManager,
      options.modelRegistry,
    );
    await host.load(options.disabledNames);
    return host;
  }

  private async load(disabledNames?: string[]) {
    for (const name of getBuiltinModuleNames(disabledNames)) {
      await this.loadModule(name);
    }
  }

  private async loadModule(name: BuiltinModuleName) {
    const moduleUrl = getBuiltinModuleUrl(name);
    const imported = await import(moduleUrl.href);
    const factory = imported?.default;
    if (typeof factory !== "function") {
      throw new Error(`builtin_module_factory_missing:${name}`);
    }
    factory(this.createApi(name, moduleUrl.pathname));
  }

  private createApi(name: string, sourcePath: string) {
    return {
      registerTool: (definition: any) => {
        const toolName = String(definition?.name || "").trim();
        if (!toolName || this.toolMap.has(toolName)) return;
        this.toolMap.set(toolName, { definition, sourcePath });
      },
      registerCommand: (commandName: string, command: any) => {
        const normalizedName = String(commandName || "").trim();
        if (!normalizedName || !command || typeof command.handler !== "function")
          return;
        this.commands.push({
          name: normalizedName,
          description: String(command.description || "").trim() || undefined,
          handler: command.handler,
          sourcePath,
        });
      },
      on: (eventName: string, handler: EventHandler) => {
        const normalizedName = String(eventName || "").trim();
        if (!normalizedName || typeof handler !== "function") return;
        const rows = this.handlers.get(normalizedName) || [];
        rows.push(handler);
        this.handlers.set(normalizedName, rows);
      },
      sendMessage: (message: any, options?: any) =>
        this.coreActions.sendMessage(message, options),
      sendUserMessage: (content: any, options?: any) =>
        this.coreActions.sendUserMessage(content, options),
      appendEntry: (customType: string, data?: unknown) =>
        this.coreActions.appendEntry(customType, data),
      setSessionName: (sessionName: string) =>
        this.coreActions.setSessionName(sessionName),
      getSessionName: () => this.coreActions.getSessionName(),
      setLabel: (entryId: string, label: string | undefined) =>
        this.coreActions.setLabel(entryId, label),
      getActiveTools: () => this.coreActions.getActiveTools(),
      getAllTools: () => this.coreActions.getAllTools(),
      setActiveTools: (toolNames: string[]) =>
        this.coreActions.setActiveTools(toolNames),
      refreshTools: () => this.coreActions.refreshTools(),
      getCommands: () => this.coreActions.getCommands(),
      setModel: (model: any) => this.coreActions.setModel(model),
      getThinkingLevel: () => this.coreActions.getThinkingLevel(),
      setThinkingLevel: (level: ThinkingLevel) =>
        this.coreActions.setThinkingLevel(level),
      __builtinCapability: name,
    };
  }

  bindCore(coreActions?: Partial<CoreActions>, contextActions?: Partial<ContextActions>) {
    this.coreActions = {
      ...noOpCoreActions,
      ...(coreActions || {}),
    };
    this.contextActions = {
      ...noOpContextActions,
      ...(contextActions || {}),
    };
  }

  setUIContext(uiContext?: any) {
    this.uiContext = uiContext || noOpUIContext;
  }

  bindCommandContext(actions?: Partial<CommandContextActions>) {
    this.commandContextActions = {
      ...noOpCommandContextActions,
      ...(actions || {}),
    };
  }

  onError(listener: ErrorListener) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emitError(error: any) {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {}
    }
  }

  hasHandlers(eventName: string) {
    return (this.handlers.get(String(eventName || "").trim()) || []).length > 0;
  }

  getToolDefinition(toolName: string) {
    return this.toolMap.get(String(toolName || "").trim())?.definition;
  }

  getAllToolDefinitions() {
    return Array.from(this.toolMap.values()).map((entry) => entry.definition);
  }

  private resolveRegisteredCommands() {
    const counts = new Map<string, number>();
    for (const command of this.commands) {
      counts.set(command.name, (counts.get(command.name) || 0) + 1);
    }
    const seen = new Map<string, number>();
    const taken = new Set<string>();
    return this.commands.map((command) => {
      const occurrence = (seen.get(command.name) || 0) + 1;
      seen.set(command.name, occurrence);
      let invocationName =
        (counts.get(command.name) || 0) > 1
          ? `${command.name}:${occurrence}`
          : command.name;
      while (taken.has(invocationName)) {
        invocationName = `${command.name}:${taken.size + 1}`;
      }
      taken.add(invocationName);
      return {
        ...command,
        invocationName,
        sourceInfo: {
          source: "builtin_module",
          path: command.sourcePath,
        },
      };
    });
  }

  getRegisteredCommands() {
    return this.resolveRegisteredCommands();
  }

  getCommand(name: string) {
    return this.resolveRegisteredCommands().find(
      (command) => command.invocationName === String(name || "").trim(),
    );
  }

  createContext() {
    const getModel = this.contextActions.getModel;
    return {
      ui: this.uiContext,
      hasUI: this.uiContext !== noOpUIContext,
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
      get model() {
        return getModel();
      },
      isIdle: () => this.contextActions.isIdle(),
      signal: this.contextActions.getSignal(),
      abort: () => this.contextActions.abort(),
      hasPendingMessages: () => this.contextActions.hasPendingMessages(),
      shutdown: () => this.contextActions.shutdown(),
      getContextUsage: () => this.contextActions.getContextUsage(),
      compact: (options?: any) => this.contextActions.compact(options),
      getSystemPrompt: () => this.contextActions.getSystemPrompt(),
      getThinkingLevel: () => this.coreActions.getThinkingLevel(),
    };
  }

  createCommandContext() {
    return {
      ...this.createContext(),
      waitForIdle: () => this.commandContextActions.waitForIdle(),
      newSession: (options?: any) => this.commandContextActions.newSession(options),
      fork: (entryId: string) => this.commandContextActions.fork(entryId),
      navigateTree: (targetId: string, options?: any) =>
        this.commandContextActions.navigateTree(targetId, options),
      switchSession: (sessionPath: string) =>
        this.commandContextActions.switchSession(sessionPath),
      reload: () => this.commandContextActions.reload(),
    };
  }

  private isSessionBeforeEvent(event: any) {
    return [
      "session_before_switch",
      "session_before_fork",
      "session_before_compact",
      "session_before_tree",
    ].includes(String(event?.type || ""));
  }

  async emit(event: any) {
    const ctx = this.createContext();
    let result: any = undefined;
    for (const handler of this.handlers.get(String(event?.type || "")) || []) {
      try {
        const handlerResult = await handler(event, ctx);
        if (this.isSessionBeforeEvent(event) && handlerResult) {
          result = handlerResult;
          if (result?.cancel) return result;
        }
      } catch (error: any) {
        this.emitError({
          extensionPath: "<builtin-module>",
          event: String(event?.type || "event"),
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
    return result;
  }

  async emitBeforeAgentStart(prompt: string, images: any[] | undefined, systemPrompt: string) {
    const ctx = this.createContext();
    const messages: any[] = [];
    let currentSystemPrompt = systemPrompt;
    let systemPromptModified = false;
    for (const handler of this.handlers.get("before_agent_start") || []) {
      try {
        const result = await handler(
          {
            type: "before_agent_start",
            prompt,
            images,
            systemPrompt: currentSystemPrompt,
          },
          ctx,
        );
        if (result?.message) messages.push(result.message);
        if (result?.systemPrompt !== undefined) {
          currentSystemPrompt = result.systemPrompt;
          systemPromptModified = true;
        }
      } catch (error: any) {
        this.emitError({
          extensionPath: "<builtin-module>",
          event: "before_agent_start",
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
    if (messages.length > 0 || systemPromptModified) {
      return {
        messages: messages.length > 0 ? messages : undefined,
        systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
      };
    }
    return undefined;
  }

  async emitInput(text: string, images: any[] | undefined, source: any) {
    const ctx = this.createContext();
    let currentText = text;
    let currentImages = images;
    for (const handler of this.handlers.get("input") || []) {
      try {
        const result = await handler(
          {
            type: "input",
            text: currentText,
            images: currentImages,
            source,
          },
          ctx,
        );
        if (result?.action === "handled") return result;
        if (result?.action === "transform") {
          currentText = result.text;
          currentImages = result.images ?? currentImages;
        }
      } catch (error: any) {
        this.emitError({
          extensionPath: "<builtin-module>",
          event: "input",
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
    return currentText !== text || currentImages !== images
      ? { action: "transform", text: currentText, images: currentImages }
      : { action: "continue" };
  }

  async emitResourcesDiscover() {
    return { skillPaths: [], promptPaths: [], themePaths: [] };
  }

  getAllRegisteredTools() {
    return Array.from(this.toolMap.values()).map((entry) => ({
      definition: entry.definition,
      sourceInfo: {
        source: "builtin_module",
        path: entry.sourcePath,
      },
    }));
  }

  getMessageRenderer() {
    return undefined;
  }

  getShortcuts() {
    return new Map();
  }

  getFlags() {
    return new Map();
  }

  getFlagValues() {
    return new Map();
  }

  setFlagValue() {}

  async emitToolResult(event: any) {
    return event;
  }

  async emitBeforeProviderRequest(payload: unknown) {
    return payload;
  }

  getExtensionPaths() {
    return [];
  }
}

function mergeCommandLists(...lists: any[][]) {
  const merged: any[] = [];
  const taken = new Set<string>();
  for (const list of lists) {
    for (const entry of list || []) {
      const baseName = String(entry?.invocationName || entry?.name || "").trim();
      if (!baseName) continue;
      let invocationName = baseName;
      let suffix = 2;
      while (taken.has(invocationName)) {
        invocationName = `${baseName}:${suffix}`;
        suffix += 1;
      }
      taken.add(invocationName);
      merged.push({
        ...entry,
        invocationName,
      });
    }
  }
  return merged;
}

export class CompositeBuiltinRunner {
  public readonly builtinHost: BuiltinModuleHost;
  private uiContext: any = undefined;
  private commandContextActions: any = undefined;

  constructor(
    private readonly externalRunner: any,
    builtinHost: BuiltinModuleHost,
  ) {
    this.builtinHost = builtinHost;
  }

  setUIContext(uiContext?: any) {
    this.uiContext = uiContext;
    this.externalRunner?.setUIContext?.(uiContext);
    this.builtinHost.setUIContext(uiContext);
  }

  bindCommandContext(actions?: any) {
    this.commandContextActions = actions;
    this.externalRunner?.bindCommandContext?.(actions);
    this.builtinHost.bindCommandContext(actions);
  }

  onError(listener: ErrorListener) {
    const externalUnsub = this.externalRunner?.onError?.(listener);
    const builtinUnsub = this.builtinHost.onError(listener);
    return () => {
      try {
        externalUnsub?.();
      } catch {}
      try {
        builtinUnsub?.();
      } catch {}
    };
  }

  emitError(error: any) {
    try {
      this.externalRunner?.emitError?.(error);
    } catch {}
    try {
      this.builtinHost.emitError(error);
    } catch {}
  }

  invalidate(message?: string) {
    this.externalRunner?.invalidate?.(message);
  }

  hasHandlers(eventName: string) {
    return Boolean(
      this.externalRunner?.hasHandlers?.(eventName) ||
        this.builtinHost.hasHandlers(eventName),
    );
  }

  getRegisteredCommands() {
    return mergeCommandLists(
      this.externalRunner?.getRegisteredCommands?.() || [],
      this.builtinHost.getRegisteredCommands(),
    );
  }

  getCommand(name: string) {
    return this.getRegisteredCommands().find(
      (command) => command.invocationName === String(name || "").trim(),
    );
  }

  createContext() {
    return {
      ...(this.externalRunner?.createContext?.() || {}),
      ...this.builtinHost.createContext(),
    };
  }

  createCommandContext() {
    return {
      ...(this.externalRunner?.createCommandContext?.() || {}),
      ...this.builtinHost.createCommandContext(),
    };
  }

  getToolDefinition(toolName: string) {
    return (
      this.builtinHost.getToolDefinition(toolName) ||
      this.externalRunner?.getToolDefinition?.(toolName)
    );
  }

  getAllRegisteredTools() {
    return [
      ...(this.externalRunner?.getAllRegisteredTools?.() || []),
      ...this.builtinHost.getAllRegisteredTools(),
    ];
  }

  getMessageRenderer(customType: string) {
    return this.externalRunner?.getMessageRenderer?.(customType);
  }

  getShortcuts(resolvedKeybindings: any) {
    return this.externalRunner?.getShortcuts?.(resolvedKeybindings) || new Map();
  }

  getCommandDiagnostics() {
    return [
      ...(this.externalRunner?.getCommandDiagnostics?.() || []),
      ...((this.builtinHost as any).getCommandDiagnostics?.() || []),
    ];
  }

  getShortcutDiagnostics() {
    return [
      ...(this.externalRunner?.getShortcutDiagnostics?.() || []),
      ...((this.builtinHost as any).getShortcutDiagnostics?.() || []),
    ];
  }

  getFlags() {
    return this.externalRunner?.getFlags?.() || new Map();
  }

  getFlagValues() {
    return this.externalRunner?.getFlagValues?.() || new Map();
  }

  setFlagValue(name: string, value: boolean | string) {
    this.externalRunner?.setFlagValue?.(name, value);
  }

  async emit(event: any) {
    const externalResult = this.externalRunner?.emit
      ? await this.externalRunner.emit(event)
      : undefined;
    if (externalResult?.cancel) return externalResult;
    const builtinResult = await this.builtinHost.emit(event);
    return builtinResult ?? externalResult;
  }

  async emitBeforeAgentStart(prompt: string, images: any[] | undefined, systemPrompt: string) {
    const externalResult = this.externalRunner?.emitBeforeAgentStart
      ? await this.externalRunner.emitBeforeAgentStart(prompt, images, systemPrompt)
      : undefined;
    const externalMessages = Array.isArray(externalResult?.messages)
      ? externalResult.messages
      : [];
    const externalPrompt =
      externalResult?.systemPrompt !== undefined
        ? externalResult.systemPrompt
        : systemPrompt;
    const builtinResult = await this.builtinHost.emitBeforeAgentStart(
      prompt,
      images,
      externalPrompt,
    );
    const mergedMessages = [
      ...externalMessages,
      ...(Array.isArray(builtinResult?.messages) ? builtinResult.messages : []),
    ];
    const finalSystemPrompt =
      builtinResult?.systemPrompt !== undefined
        ? builtinResult.systemPrompt
        : externalResult?.systemPrompt;
    if (mergedMessages.length > 0 || finalSystemPrompt !== undefined) {
      return {
        messages: mergedMessages.length > 0 ? mergedMessages : undefined,
        systemPrompt: finalSystemPrompt,
      };
    }
    return undefined;
  }

  async emitInput(text: string, images: any[] | undefined, source: any) {
    const externalResult = this.externalRunner?.emitInput
      ? await this.externalRunner.emitInput(text, images, source)
      : { action: "continue" };
    if (externalResult?.action === "handled") return externalResult;
    const nextText =
      externalResult?.action === "transform" ? externalResult.text : text;
    const nextImages =
      externalResult?.action === "transform"
        ? externalResult.images ?? images
        : images;
    const builtinResult = await this.builtinHost.emitInput(
      nextText,
      nextImages,
      source,
    );
    if (builtinResult?.action === "handled") return builtinResult;
    if (
      builtinResult?.action === "transform" ||
      externalResult?.action === "transform"
    ) {
      return {
        action: "transform",
        text:
          builtinResult?.action === "transform"
            ? builtinResult.text
            : nextText,
        images:
          builtinResult?.action === "transform"
            ? builtinResult.images ?? nextImages
            : nextImages,
      };
    }
    return { action: "continue" };
  }

  async emitResourcesDiscover(cwd: string, reason: "startup" | "reload") {
    const externalResult = this.externalRunner?.emitResourcesDiscover
      ? await this.externalRunner.emitResourcesDiscover(cwd, reason)
      : { skillPaths: [], promptPaths: [], themePaths: [] };
    const builtinResult = await this.builtinHost.emitResourcesDiscover();
    return {
      skillPaths: [
        ...(externalResult?.skillPaths || []),
        ...(builtinResult?.skillPaths || []),
      ],
      promptPaths: [
        ...(externalResult?.promptPaths || []),
        ...(builtinResult?.promptPaths || []),
      ],
      themePaths: [
        ...(externalResult?.themePaths || []),
        ...(builtinResult?.themePaths || []),
      ],
    };
  }

  async emitToolResult(event: any) {
    return this.externalRunner?.emitToolResult
      ? await this.externalRunner.emitToolResult(event)
      : event;
  }

  async emitBeforeProviderRequest(payload: unknown) {
    return this.externalRunner?.emitBeforeProviderRequest
      ? await this.externalRunner.emitBeforeProviderRequest(payload)
      : payload;
  }

  getExtensionPaths() {
    return this.externalRunner?.getExtensionPaths?.() || [];
  }
}
