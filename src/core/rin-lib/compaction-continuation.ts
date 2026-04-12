import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type CompactionContinuationMarker = {
  version: 1;
  reason: "threshold" | "overflow";
  at: number;
  assistantPreview?: string;
};

const CONTINUATION_MARKER_DIR = join(tmpdir(), "rin-compaction-continuation");

function readSessionIdentity(source: any): string {
  const sessionManager = source?.sessionManager || source;
  const sessionFile = sessionManager?.getSessionFile?.();
  const sessionId = sessionManager?.getSessionId?.();
  const cwd = source?.cwd || sessionManager?.getCwd?.();
  return String(sessionFile || sessionId || cwd || "unknown-session");
}

export function getCompactionContinuationMarkerPath(source: any): string {
  const hash = createHash("sha1")
    .update(readSessionIdentity(source))
    .digest("hex");
  return join(CONTINUATION_MARKER_DIR, `${hash}.json`);
}

export function writeCompactionContinuationMarker(
  source: any,
  marker: Omit<CompactionContinuationMarker, "version" | "at"> & {
    at?: number;
  },
) {
  const file = getCompactionContinuationMarkerPath(source);
  mkdirSync(dirname(file), { recursive: true });
  const next: CompactionContinuationMarker = {
    version: 1,
    at: Number(marker?.at || Date.now()),
    reason: marker.reason,
    assistantPreview:
      String(marker?.assistantPreview || "").trim() || undefined,
  };
  writeFileSync(file, JSON.stringify(next), "utf8");
  return next;
}

export function consumeCompactionContinuationMarker(
  source: any,
): CompactionContinuationMarker | undefined {
  const file = getCompactionContinuationMarkerPath(source);
  try {
    const raw = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    const parsed = JSON.parse(raw) as CompactionContinuationMarker;
    if (!parsed || parsed.version !== 1) return undefined;
    if (parsed.reason !== "threshold" && parsed.reason !== "overflow")
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function clearCompactionContinuationMarker(source: any) {
  try {
    rmSync(getCompactionContinuationMarkerPath(source), { force: true });
  } catch {}
}
