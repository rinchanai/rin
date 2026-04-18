import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "../platform/fs.js";
import { readSessionIdentity } from "../session/metadata.js";

export type CompactionContinuationMarker = {
  version: 1;
  reason: "threshold" | "overflow";
  at: number;
  assistantPreview?: string;
};

const CONTINUATION_MARKER_ROOT = [
  process.env.RIN_TMP_DIR,
  "/home/rin/tmp",
  tmpdir(),
]
  .map((value) => String(value || "").trim())
  .find(Boolean) as string;
const CONTINUATION_MARKER_DIR = join(
  CONTINUATION_MARKER_ROOT,
  "rin-compaction-continuation",
);

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
