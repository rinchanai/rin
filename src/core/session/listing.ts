import path from "node:path";

import { safeString } from "../text-utils.js";

export type BoundSessionListItem = {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: Date;
};

function nonEmptyString(value: unknown): string | undefined {
  const next = safeString(value).trim();
  return next || undefined;
}

function normalizeModified(value: unknown, fallback?: unknown) {
  const candidate =
    value instanceof Date
      ? value
      : new Date(nonEmptyString(value) || nonEmptyString(fallback) || Date.now());
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

export function normalizeBoundSessionListItem(
  session: any,
): BoundSessionListItem | null {
  const sessionPath = nonEmptyString(session?.path) || nonEmptyString(session?.id);
  if (!sessionPath) return null;
  const id = nonEmptyString(session?.id) || sessionPath;
  return {
    id,
    path: sessionPath,
    name: nonEmptyString(session?.name),
    firstMessage:
      nonEmptyString(session?.firstMessage) ||
      nonEmptyString(session?.title) ||
      id ||
      "Untitled session",
    modified: normalizeModified(session?.modified, session?.subtitle),
  };
}

export function normalizeBoundSessionList(sessions: any): BoundSessionListItem[] {
  const seen = new Set<string>();
  return (Array.isArray(sessions) ? sessions : [])
    .map(normalizeBoundSessionListItem)
    .filter((item): item is BoundSessionListItem => Boolean(item))
    .filter((item) => {
      const resolvedPath = path.resolve(item.path);
      if (seen.has(resolvedPath)) return false;
      seen.add(resolvedPath);
      return true;
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function getBoundSessionDisplayTitle(session: any): string {
  const normalized = normalizeBoundSessionListItem(session);
  return normalized?.name || normalized?.firstMessage || "Untitled session";
}

export function getBoundSessionSubtitle(session: any): string | undefined {
  const text =
    (typeof session?.modified === "string" && nonEmptyString(session.modified)) ||
    (typeof session?.subtitle === "string" && nonEmptyString(session.subtitle));
  if (text) return text;
  const normalized = normalizeBoundSessionListItem(session);
  return normalized ? normalized.modified.toISOString() : undefined;
}

export function isActiveBoundSession(session: any, activePath?: string): boolean {
  const normalized = normalizeBoundSessionListItem(session);
  const targetPath = nonEmptyString(activePath);
  if (!normalized || !targetPath) return false;
  return path.resolve(normalized.path) === path.resolve(targetPath);
}
