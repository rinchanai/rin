import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type FrozenPromptSnapshot = {
  version: 1;
  systemPrompt: string;
  updatedAt: string;
};

const SNAPSHOT_TYPE = "frozen-system-prompt";
const RELOAD_MARKER_DIR = join(tmpdir(), "rin-frozen-runtime");

function getSessionKey(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  const sessionId = ctx.sessionManager.getSessionId?.();
  return String(sessionFile || sessionId || ctx.cwd || "unknown-session");
}

function getReloadMarkerPath(ctx: ExtensionContext): string {
  const hash = createHash("sha1").update(getSessionKey(ctx)).digest("hex");
  return join(RELOAD_MARKER_DIR, `${hash}.json`);
}

function markReload(ctx: ExtensionContext): void {
  const file = getReloadMarkerPath(ctx);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, at: Date.now() }),
    "utf8",
  );
}

function consumeReloadMarker(ctx: ExtensionContext): boolean {
  const file = getReloadMarkerPath(ctx);
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as { pid?: number };
    rmSync(file, { force: true });
    return data.pid === process.pid;
  } catch {
    return false;
  }
}

function findSnapshot(ctx: ExtensionContext): FrozenPromptSnapshot | undefined {
  let snapshot: FrozenPromptSnapshot | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;
    const data = entry.data as FrozenPromptSnapshot | undefined;
    if (!data || data.version !== 1 || typeof data.systemPrompt !== "string")
      continue;
    snapshot = data;
  }
  return snapshot;
}

function persistSnapshot(
  pi: ExtensionAPI,
  systemPrompt: string,
): FrozenPromptSnapshot {
  const snapshot: FrozenPromptSnapshot = {
    version: 1,
    systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  pi.appendEntry<FrozenPromptSnapshot>(SNAPSHOT_TYPE, snapshot);
  return snapshot;
}

export default function freezeSessionRuntimeExtension(pi: ExtensionAPI) {
  let snapshot: FrozenPromptSnapshot | undefined;
  let reloadPending = false;

  function restore(ctx: ExtensionContext) {
    reloadPending = consumeReloadMarker(ctx);
    snapshot = reloadPending ? undefined : findSnapshot(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    markReload(ctx);
    snapshot = undefined;
    reloadPending = true;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    markReload(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!snapshot || reloadPending) {
      snapshot = persistSnapshot(pi, event.systemPrompt);
      reloadPending = false;
    }

    return {
      systemPrompt: snapshot.systemPrompt,
    };
  });
}
