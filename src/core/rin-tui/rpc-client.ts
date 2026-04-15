import net from "node:net";

import { defaultDaemonSocketPath, parseJsonl } from "../rin-lib/common.js";
import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import type {
  FrontendAutocompleteItem,
  FrontendCommandItem,
  FrontendDialogSpec,
  FrontendModelItem,
  FrontendSessionItem,
  InteractiveFrontendEvent,
  InteractiveFrontendSurface,
} from "./frontend-surface.js";

function toFrontendEvent(event: any): InteractiveFrontendEvent | null {
  if (!event || typeof event !== "object") return null;

  if (event.type === "stderr") {
    return { type: "status", level: "warning", text: String(event.line || "") };
  }

  if (event.type === "worker_exit") {
    return {
      type: "status",
      level: "error",
      text: `worker exited: code=${String(event.code)} signal=${String(event.signal)}`,
    };
  }

  if (event.type === "response") {
    return { type: "ui", name: "response", payload: event };
  }

  return { type: "ui", name: String(event.type || "event"), payload: event };
}

function extractSlashCommandName(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return "";
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
}

export class RinDaemonFrontendClient implements InteractiveFrontendSurface {
  socketPath: string;
  socket: net.Socket | null = null;
  state = { buffer: "" };
  requestId = 0;
  pending = new Map<
    string,
    { resolve: Function; reject: Function; timer: NodeJS.Timeout }
  >();
  listeners = new Set<(event: InteractiveFrontendEvent) => void>();
  connectPromise: Promise<void> | null = null;

  constructor(socketPath = defaultDaemonSocketPath()) {
    this.socketPath = socketPath;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return await this.connectPromise;
    const wasDisconnected = !this.socket || this.socket.destroyed;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const onError = (error: Error) => {
        try {
          socket.destroy();
        } catch {}
        this.connectPromise = null;
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        this.state.buffer = "";
        socket.on("data", (chunk) => this.handleChunk(String(chunk), socket));
        socket.on("close", () => this.handleDisconnect(true, socket));
        socket.on("error", () => this.handleDisconnect(true, socket));
        this.connectPromise = null;
        if (wasDisconnected) {
          this.emit({
            type: "ui",
            name: "connection_restored",
            payload: { socketPath: this.socketPath },
          });
        }
        resolve();
      });
    });
    return await this.connectPromise;
  }

  async disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (!socket) return;
    try {
      socket.end();
    } catch {}
    try {
      socket.destroy();
    } catch {}
    this.handleDisconnect(false, socket);
  }

  subscribe(listener: (event: InteractiveFrontendEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(text: string) {
    const commandName = extractSlashCommandName(text);
    if (!commandName) {
      await this.send({ type: "prompt", message: text });
      return;
    }

    const builtin = BUILTIN_SLASH_COMMANDS.some(
      (command) => command.name === commandName,
    );
    if (builtin) {
      await this.send({ type: "run_command", commandLine: String(text).trim() });
      return;
    }

    const commands = await this.getCommands().catch(() => []);
    const matched = commands.find((command) => command.name === commandName);
    if (matched?.category === "extension") {
      await this.send({ type: "run_command", commandLine: String(text).trim() });
      return;
    }

    await this.send({ type: "prompt", message: text });
  }

  async abort() {
    await this.send({ type: "abort" });
  }

  async getAutocompleteItems(
    _input: string,
  ): Promise<FrontendAutocompleteItem[]> {
    const commands = await this.getCommands().catch(() => []);
    return commands.map((command) => ({
      id: command.id,
      label: command.name,
      insertText: command.name.startsWith("/")
        ? command.name
        : `/${command.name}`,
      detail: command.description,
      kind: "command" as const,
    }));
  }

  async getCommands(): Promise<FrontendCommandItem[]> {
    if (!this.isConnected()) {
      return BUILTIN_SLASH_COMMANDS.map((command) => ({
        id: command.name,
        name: command.name,
        description: command.description,
      }));
    }
    const data = this.getData(await this.send({ type: "get_commands" }));
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    return commands.map((command: any) => ({
      id: String(command.name || command.id || ""),
      name: String(command.name || ""),
      description:
        typeof command.description === "string"
          ? command.description
          : undefined,
      category:
        typeof command.category === "string"
          ? command.category
          : typeof command.source === "string"
            ? command.source
            : undefined,
    }));
  }

  async listSessions(): Promise<FrontendSessionItem[]> {
    if (!this.isConnected()) return [];
    const [sessionsResponse, stateResponse]: any = await Promise.all([
      this.send({ type: "list_sessions", scope: "all" }),
      this.send({ type: "get_state" }).catch(() => ({ success: false })),
    ]);
    const data = this.getData(sessionsResponse);
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const activePath =
      stateResponse && stateResponse.success === true
        ? stateResponse.data?.sessionFile
        : undefined;
    return sessions.map((session: any) => ({
      id: String(session.path || session.id || ""),
      title: String(
        session.name ||
          session.id ||
          session.firstMessage ||
          "Untitled session",
      ),
      subtitle:
        typeof session.modified === "string" ? session.modified : undefined,
      isActive: activePath
        ? String(session.path || "") === String(activePath)
        : false,
    }));
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath: sessionId });
  }

  async listModels(): Promise<FrontendModelItem[]> {
    if (!this.isConnected()) return [];
    const data = this.getData(
      await this.send({ type: "get_available_models" }),
    );
    const models = Array.isArray(data?.models) ? data.models : [];
    return models.map((model: any) => ({
      id: String(model.id || ""),
      label: String(model.label || model.id || ""),
      provider: typeof model.provider === "string" ? model.provider : undefined,
      description:
        typeof model.description === "string" ? model.description : undefined,
    }));
  }

  async openDialog(_id: string): Promise<FrontendDialogSpec | null> {
    return null;
  }

  async respondDialog(_id: string, _payload: unknown): Promise<void> {}

  isConnected() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  async send(command: any) {
    if (!this.socket || this.socket.destroyed)
      throw new Error("rin_tui_not_connected");
    const id = `req_${++this.requestId}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rin_timeout:${String(command?.type || "command")}`));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private handleChunk(chunk: string, socket?: net.Socket) {
    if (socket && this.socket !== socket) return;
    parseJsonl(chunk, this.state, (line) => this.handleLine(line));
  }

  private handleLine(line: string) {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (data?.type === "response" && data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    const event = toFrontendEvent(data);
    if (!event) return;
    this.emit(event);
  }

  private handleDisconnect(emitEvent = true, socket?: net.Socket) {
    if (socket && this.socket && this.socket !== socket) return;
    if (!this.socket && !this.connectPromise) return;
    this.socket = null;
    this.connectPromise = null;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error(`rin_disconnected:${id}`));
      } catch {}
    }
    this.pending.clear();
    if (emitEvent) {
      this.emit({
        type: "ui",
        name: "connection_lost",
        payload: { socketPath: this.socketPath },
      });
    }
  }

  private emit(event: InteractiveFrontendEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private getData(response: any) {
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || "rin_request_failed"));
    }
    return response.data;
  }
}
