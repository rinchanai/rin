import type {
  BuiltinModuleApi,
  BuiltinModuleContext,
} from "../builtins/host.js";

type FrozenPromptSnapshot = {
  version: 1;
  systemPrompt: string;
  updatedAt: string;
};

const SNAPSHOT_TYPE = "frozen-system-prompt";

function findSnapshot(
  ctx: BuiltinModuleContext,
): FrozenPromptSnapshot | undefined {
  let snapshot: FrozenPromptSnapshot | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "compaction") {
      snapshot = undefined;
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;
    const data = entry.data as FrozenPromptSnapshot | undefined;
    if (!data || data.version !== 1 || typeof data.systemPrompt !== "string")
      continue;
    snapshot = data;
  }
  return snapshot;
}

function persistSnapshot(
  pi: BuiltinModuleApi,
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

export default function freezeSessionRuntimeModule(pi: BuiltinModuleApi) {
  let snapshot: FrozenPromptSnapshot | undefined;
  let refreshPending = false;

  function restore(ctx: BuiltinModuleContext) {
    snapshot = findSnapshot(ctx);
    refreshPending = false;
  }

  function requestRefresh() {
    snapshot = undefined;
    refreshPending = true;
  }

  pi.on("session_start", async (event, ctx) => {
    if (String(event?.reason || "") === "reload") {
      requestRefresh();
      return;
    }
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_compact", async () => {
    requestRefresh();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!snapshot && !refreshPending) {
      snapshot = findSnapshot(ctx);
    }
    if (!snapshot || refreshPending) {
      snapshot = persistSnapshot(pi, event.systemPrompt);
      refreshPending = false;
    }

    return {
      systemPrompt: snapshot.systemPrompt,
    };
  });
}
