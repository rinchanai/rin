import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  preferredTempRootCandidates,
  writeJsonAtomic,
} from "../platform/fs.js";
import { readSessionIdentity } from "../session/metadata.js";

export type CompactionContinuationMarker = {
  version: 1;
  reason: "threshold" | "overflow";
  at: number;
  assistantPreview?: string;
};

function compactionContinuationMarkerDir() {
  return join(
    preferredTempRootCandidates()[0],
    "rin-compaction-continuation",
  );
}

function parseCompactionContinuationMarker(
  value: unknown,
): CompactionContinuationMarker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as CompactionContinuationMarker;
  if (parsed.version !== 1) return undefined;
  if (parsed.reason !== "threshold" && parsed.reason !== "overflow") {
    return undefined;
  }
  return parsed;
}

export function getCompactionContinuationMarkerPath(source: any): string {
  const hash = createHash("sha1")
    .update(readSessionIdentity(source))
    .digest("hex");
  return join(compactionContinuationMarkerDir(), `${hash}.json`);
}

export function writeCompactionContinuationMarker(
  source: any,
  marker: Omit<CompactionContinuationMarker, "version" | "at"> & {
    at?: number;
  },
) {
  const file = getCompactionContinuationMarkerPath(source);
  const next: CompactionContinuationMarker = {
    version: 1,
    at: Number(marker?.at || Date.now()),
    reason: marker.reason,
    assistantPreview: String(marker?.assistantPreview || "").trim() || undefined,
  };
  writeJsonAtomic(file, next);
  return next;
}

export function consumeCompactionContinuationMarker(
  source: any,
): CompactionContinuationMarker | undefined {
  const file = getCompactionContinuationMarkerPath(source);
  try {
    const raw = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    return parseCompactionContinuationMarker(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function clearCompactionContinuationMarker(source: any) {
  try {
    rmSync(getCompactionContinuationMarkerPath(source), { force: true });
  } catch {}
}
