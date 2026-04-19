import os from "node:os";

import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import type {
  SubagentSessionConfig,
  SubagentSessionMode,
} from "./types.js";

const HOME_DIR = os.homedir();
const SESSION_REF_TARGET_DESCRIPTION =
  "a session file path, exact id, or unique id prefix";

export type NormalizedSubagentSessionConfig =
  Required<Pick<SubagentSessionConfig, "mode">> & SubagentSessionConfig;

export function normalizeSubagentSessionConfig(
  session: SubagentSessionConfig | undefined,
): NormalizedSubagentSessionConfig {
  const mode = (session?.mode || "memory") as SubagentSessionMode;
  return {
    mode,
    ref: String(session?.ref || "").trim() || undefined,
    name: String(session?.name || "").trim() || undefined,
    keep:
      typeof session?.keep === "boolean" ? session.keep : undefined,
  };
}

export function getDefaultSubagentSessionDir() {
  const profile = resolveRuntimeProfile({ cwd: HOME_DIR });
  return getRuntimeSessionDir(profile.cwd, profile.agentDir);
}

export function formatSubagentSessionRefRequiredError(
  mode: Extract<SubagentSessionMode, "resume" | "fork">,
): string {
  return `Session ref is required when session.mode is ${mode}. Inspect ${getDefaultSubagentSessionDir()} and use ${SESSION_REF_TARGET_DESCRIPTION}.`;
}

export function formatSubagentSessionRefAmbiguousError(ref: string): string {
  return `Session ref is ambiguous: ${ref}. Inspect ${getDefaultSubagentSessionDir()} and use an exact path or a less ambiguous id prefix.`;
}

export function formatSubagentSessionRefNotFoundError(ref: string): string {
  return `Session not found: ${ref}. Inspect ${getDefaultSubagentSessionDir()} and use ${SESSION_REF_TARGET_DESCRIPTION}.`;
}

export function formatSubagentSessionRefHint(): string {
  return `Hint: inspect ${getDefaultSubagentSessionDir()} with bash/find/rg, then pass session.ref as ${SESSION_REF_TARGET_DESCRIPTION}.`;
}
