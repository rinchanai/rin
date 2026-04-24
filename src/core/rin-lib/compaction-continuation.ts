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

function compactionContinuationMarkerDirs() {
  return preferredTempRootCandidates().map((root) =>
    join(root, "rin-compaction-continuation"),
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

function getCompactionContinuationMarkerPaths(source: any): string[] {
  const hash = createHash("sha1")
    .update(readSessionIdentity(source))
    .digest("hex");
  return compactionContinuationMarkerDirs().map((dir) =>
    join(dir, `${hash}.json`),
  );
}

export function getCompactionContinuationMarkerPath(source: any): string {
  return getCompactionContinuationMarkerPaths(source)[0];
}

export function writeCompactionContinuationMarker(
  source: any,
  marker: Omit<CompactionContinuationMarker, "version" | "at"> & {
    at?: number;
  },
) {
  const next: CompactionContinuationMarker = {
    version: 1,
    at: Number(marker?.at || Date.now()),
    reason: marker.reason,
    assistantPreview:
      String(marker?.assistantPreview || "").trim() || undefined,
  };
  let lastError: unknown;
  for (const file of getCompactionContinuationMarkerPaths(source)) {
    try {
      writeJsonAtomic(file, next);
      return next;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function consumeCompactionContinuationMarker(
  source: any,
): CompactionContinuationMarker | undefined {
  for (const file of getCompactionContinuationMarkerPaths(source)) {
    try {
      const raw = readFileSync(file, "utf8");
      rmSync(file, { force: true });
      const marker = parseCompactionContinuationMarker(JSON.parse(raw));
      if (marker) return marker;
    } catch {}
  }
  return undefined;
}

export function clearCompactionContinuationMarker(source: any) {
  for (const file of getCompactionContinuationMarkerPaths(source)) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}
