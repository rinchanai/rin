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

export const VALID_SUBAGENT_SESSION_MODES = [
  "memory",
  "persist",
  "resume",
  "fork",
] as const satisfies SubagentSessionMode[];

export type NormalizedSubagentSessionConfig =
  Required<Pick<SubagentSessionConfig, "mode">> &
    SubagentSessionConfig & {
      invalidMode?: string;
    };

function normalizeSessionMode(value: unknown) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) return { mode: "memory" as SubagentSessionMode };
  if ((VALID_SUBAGENT_SESSION_MODES as readonly string[]).includes(mode)) {
    return { mode: mode as SubagentSessionMode };
  }
  return {
    mode: "memory" as SubagentSessionMode,
    invalidMode: mode,
  };
}

export function normalizeSubagentSessionConfig(
  session: SubagentSessionConfig | undefined,
): NormalizedSubagentSessionConfig {
  const normalizedMode = normalizeSessionMode(session?.mode);
  return {
    ...normalizedMode,
    ref: String(session?.ref || "").trim() || undefined,
    name: String(session?.name || "").trim() || undefined,
    keep: typeof session?.keep === "boolean" ? session.keep : undefined,
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

export function formatSubagentSessionModeInvalidError(mode: string): string {
  return `Invalid session.mode: ${mode}. Allowed values: ${VALID_SUBAGENT_SESSION_MODES.join(", ")}.`;
}
