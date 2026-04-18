import vm from "node:vm";
import { safeString } from "../text-utils.js";

const DEFAULT_CHAT_BRIDGE_TIMEOUT_MS = 10_000;
const MAX_CHAT_BRIDGE_TIMEOUT_MS = 120_000;
const MAX_CHAT_BRIDGE_RENDER_CHARS = 20_000;
const MAX_CHAT_BRIDGE_STRING_CHARS = 4_000;
const MAX_CHAT_BRIDGE_ARRAY_ITEMS = 100;
const MAX_CHAT_BRIDGE_OBJECT_KEYS = 100;
const MAX_CHAT_BRIDGE_DEPTH = 6;

let cachedTypeScriptModule: any | null | undefined;

async function loadTypeScriptModule() {
  if (cachedTypeScriptModule !== undefined) return cachedTypeScriptModule;
  try {
    cachedTypeScriptModule = await import("typescript");
    return cachedTypeScriptModule;
  } catch {
    cachedTypeScriptModule = null;
    return null;
  }
}

function truncateString(text: string, maxChars = MAX_CHAT_BRIDGE_STRING_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16))}… [${text.length - maxChars} more chars]`;
}

function formatDiagnostic(ts: any, diagnostic: any) {
  const message = ts.flattenDiagnosticMessageText(
    diagnostic?.messageText,
    "\n",
  );
  const line = Number(
    diagnostic?.file?.getLineAndCharacterOfPosition?.(diagnostic.start ?? 0)
      ?.line,
  );
  const column = Number(
    diagnostic?.file?.getLineAndCharacterOfPosition?.(diagnostic.start ?? 0)
      ?.character,
  );
  if (Number.isFinite(line) && Number.isFinite(column)) {
    return `${line + 1}:${column + 1} ${message}`;
  }
  return message;
}

export function clampChatBridgeTimeoutMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_CHAT_BRIDGE_TIMEOUT_MS;
  return Math.min(MAX_CHAT_BRIDGE_TIMEOUT_MS, Math.max(1, Math.round(parsed)));
}

export async function transpileChatBridgeCode(code: string) {
  const source = safeString(code);
  const wrapped = `globalThis.__chat_bridge__ = async () => {\n${source}\n};\n`;
  const ts = await loadTypeScriptModule();
  if (!ts) return wrapped;
  const result = ts.transpileModule(wrapped, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: false,
      useDefineForClassFields: false,
    },
    reportDiagnostics: true,
  });
  const diagnostics = Array.isArray(result.diagnostics)
    ? result.diagnostics.filter(
        (item: any) => item?.category === ts.DiagnosticCategory.Error,
      )
    : [];
  if (diagnostics.length) {
    throw new Error(
      `chat_bridge_transpile_failed:\n${diagnostics
        .slice(0, 8)
        .map((item: any) => formatDiagnostic(ts, item))
        .join("\n")}`,
    );
  }
  return safeString(result.outputText);
}

function serializeError(error: any, seen: WeakSet<object>, depth: number) {
  const message = safeString(error?.message || error).trim() || "unknown_error";
  const out: Record<string, unknown> = {
    name: safeString(error?.name).trim() || "Error",
    message,
  };
  const stack = safeString(error?.stack).trim();
  if (stack)
    out.stack = truncateString(stack, MAX_CHAT_BRIDGE_STRING_CHARS * 2);
  const cause = error?.cause;
  if (cause && depth < MAX_CHAT_BRIDGE_DEPTH) {
    out.cause = serializeBridgeValue(cause, seen, depth + 1);
  }
  return out;
}

export function serializeBridgeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value == null) return null;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") {
    return `[Function ${safeString((value as any)?.name).trim() || "anonymous"}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      length: value.length,
      preview: truncateString(value.toString("utf8"), 512),
    };
  }
  if (value instanceof Error) {
    return serializeError(value, seen, depth);
  }
  if (depth >= MAX_CHAT_BRIDGE_DEPTH) return "[MaxDepth]";
  if (typeof value !== "object") return safeString(value);
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_CHAT_BRIDGE_ARRAY_ITEMS)
      .map((item) => serializeBridgeValue(item, seen, depth + 1));
    if (value.length > MAX_CHAT_BRIDGE_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_CHAT_BRIDGE_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  if (value instanceof Map) {
    return {
      type: "Map",
      entries: Array.from(value.entries())
        .slice(0, MAX_CHAT_BRIDGE_ARRAY_ITEMS)
        .map(([key, item]) => [
          serializeBridgeValue(key, seen, depth + 1),
          serializeBridgeValue(item, seen, depth + 1),
        ]),
    };
  }

  if (value instanceof Set) {
    return {
      type: "Set",
      values: Array.from(value.values())
        .slice(0, MAX_CHAT_BRIDGE_ARRAY_ITEMS)
        .map((item) => serializeBridgeValue(item, seen, depth + 1)),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_CHAT_BRIDGE_OBJECT_KEYS,
  );
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    out[key] = serializeBridgeValue(item, seen, depth + 1);
  }
  const totalKeys = Object.keys(value as Record<string, unknown>).length;
  if (totalKeys > MAX_CHAT_BRIDGE_OBJECT_KEYS) {
    out.__truncatedKeys = totalKeys - MAX_CHAT_BRIDGE_OBJECT_KEYS;
  }
  return out;
}

export function renderChatBridgeResult(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  const text = JSON.stringify(value, null, 2);
  if (!text) return String(value);
  return text.length <= MAX_CHAT_BRIDGE_RENDER_CHARS
    ? text
    : `${text.slice(0, MAX_CHAT_BRIDGE_RENDER_CHARS - 24)}\n… [output truncated]`;
}

export async function executeChatBridgeCode(options: {
  code: string;
  context: Record<string, unknown>;
  timeoutMs?: number;
  filename?: string;
}) {
  const timeoutMs = clampChatBridgeTimeoutMs(options.timeoutMs);
  const sandbox = vm.createContext(
    {
      ...options.context,
      globalThis: undefined,
    },
    {
      name: "rin-chat-bridge",
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    },
  );
  (sandbox as any).globalThis = sandbox;
  const transpiled = await transpileChatBridgeCode(options.code);
  const script = new vm.Script(transpiled, {
    filename: safeString(options.filename).trim() || "chat-bridge.ts",
  });
  script.runInContext(sandbox, { timeout: timeoutMs });
  const bridgeFn = (sandbox as any).__chat_bridge__;
  if (typeof bridgeFn !== "function") {
    throw new Error("chat_bridge_entry_missing");
  }
  const result = await Promise.race([
    Promise.resolve().then(() => bridgeFn()),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`chat_bridge_timeout:${timeoutMs}`)),
        timeoutMs,
      );
    }),
  ]);
  const serialized = serializeBridgeValue(result);
  return {
    timeoutMs,
    value: serialized,
    text: renderChatBridgeResult(serialized),
  };
}
