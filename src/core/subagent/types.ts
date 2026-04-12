import type { AgentMessage as Message, ThinkingLevel } from "@mariozechner/pi-agent-core";

export type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

export type SubagentSessionMode = "memory" | "persist" | "resume" | "fork";

export type SubagentSessionConfig = {
  mode?: SubagentSessionMode;
  ref?: string;
  name?: string;
};

export type SubagentTask = {
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  session?: SubagentSessionConfig;
};

export type RunSubagentParams = {
  prompt?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  session?: SubagentSessionConfig;
  tasks?: SubagentTask[];
};

export type TaskResult = {
  index: number;
  prompt: string;
  requestedModel?: string;
  requestedThinkingLevel?: ThinkingLevel;
  status: "pending" | "running" | "done" | "error";
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  output: string;
  model?: string;
  usage: UsageStats;
  messages: Message[];
  sessionMode: SubagentSessionMode;
  sessionPersisted: boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
};

export type ProviderModelSummary = {
  provider: string;
  count: number;
  top3: string[];
  all: string[];
};

export type SubagentBackendInfo = {
  backend: "in-process-session";
  currentModel?: string;
  currentThinkingLevel: ThinkingLevel;
  providers: ProviderModelSummary[];
};
