import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export function applyRpcSessionState(
  target: {
    model: any;
    thinkingLevel: ThinkingLevel;
    steeringMode: "all" | "one-at-a-time";
    followUpMode: "all" | "one-at-a-time";
    isStreaming: boolean;
    isCompacting: boolean;
    pendingMessageCount: number;
    autoCompactionEnabled: boolean;
    sessionId: string;
    sessionFile?: string;
    sessionName?: string;
    state: any;
  },
  state: any,
) {
  const sessionId = String(state?.sessionId || "");
  const sessionFile =
    typeof state?.sessionFile === "string" ? state.sessionFile : undefined;

  target.model = state?.model ?? null;
  target.thinkingLevel = state?.thinkingLevel ?? target.thinkingLevel;
  target.steeringMode = state?.steeringMode ?? target.steeringMode;
  target.followUpMode = state?.followUpMode ?? target.followUpMode;
  target.autoCompactionEnabled = Boolean(state?.autoCompactionEnabled);
  if (typeof (target as any).setRemoteTurnRunning === "function") {
    (target as any).setRemoteTurnRunning(Boolean(state?.isStreaming));
  } else {
    target.isStreaming = Boolean(state?.isStreaming);
  }
  target.isCompacting = Boolean(state?.isCompacting);
  target.pendingMessageCount = Number(state?.pendingMessageCount || 0);
  target.sessionId = sessionId;
  target.sessionFile = sessionFile;
  target.sessionName =
    typeof state?.sessionName === "string" ? state.sessionName : undefined;
  target.state.model = target.model;
  target.state.thinkingLevel = target.thinkingLevel;
}

export function applyRpcMessages(
  target: { messages: any[]; state: any },
  data: any,
) {
  target.messages = Array.isArray(data?.messages) ? data.messages : [];
  target.state.messages = target.messages;
}

export function applyRpcSessionTree(
  target: {
    entries: any[];
    tree: any[];
    leafId: string | null;
    entryById: Map<string, any>;
    labelsById: Map<string, string | undefined>;
  },
  entriesData: any,
  treeData: any,
) {
  target.entries = Array.isArray(entriesData?.entries)
    ? entriesData.entries
    : [];
  target.tree = Array.isArray(treeData?.tree) ? treeData.tree : [];
  target.leafId = typeof treeData?.leafId === "string" ? treeData.leafId : null;
  target.entryById = new Map(
    target.entries.map((entry: any) => [String(entry.id), entry]),
  );
  target.labelsById = new Map();
  const visitTree = (nodes: any[]) => {
    for (const node of nodes) {
      if (node?.entry?.id)
        target.labelsById.set(String(node.entry.id), node.label);
      if (Array.isArray(node?.children)) visitTree(node.children);
    }
  };
  visitTree(target.tree);
}

export function getSessionBranch(
  entryById: Map<string, any>,
  leafId: string | null,
  fromId?: string,
) {
  const targetId = fromId ?? leafId;
  if (!targetId) return [];
  const branch: any[] = [];
  let current = entryById.get(targetId);
  while (current) {
    branch.push(current);
    if (!current.parentId) break;
    current = entryById.get(current.parentId);
  }
  return branch.reverse();
}
