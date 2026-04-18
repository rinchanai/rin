import path from "node:path";

import { normalizeSessionValue } from "./metadata.js";

export type BoundSessionListItem = {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: Date;
};

function isBoundSessionListItem(value: unknown): value is BoundSessionListItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as BoundSessionListItem).id === "string" &&
      typeof (value as BoundSessionListItem).path === "string" &&
      ((value as BoundSessionListItem).name === undefined ||
        typeof (value as BoundSessionListItem).name === "string") &&
      typeof (value as BoundSessionListItem).firstMessage === "string" &&
      (value as BoundSessionListItem).modified instanceof Date &&
      Number.isFinite((value as BoundSessionListItem).modified.getTime()),
  );
}

function normalizeModified(value: unknown, fallback?: unknown) {
  const candidate =
    value instanceof Date
      ? value
      : new Date(
          normalizeSessionValue(value) ||
            normalizeSessionValue(fallback) ||
            Date.now(),
        );
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

export function normalizeBoundSessionListItem(
  session: any,
): BoundSessionListItem | null {
  if (isBoundSessionListItem(session)) return session;
  const sessionPath =
    normalizeSessionValue(session?.path) || normalizeSessionValue(session?.id);
  if (!sessionPath) return null;
  const id = normalizeSessionValue(session?.id) || sessionPath;
  return {
    id,
    path: sessionPath,
    name: normalizeSessionValue(session?.name),
    firstMessage:
      normalizeSessionValue(session?.firstMessage) ||
      normalizeSessionValue(session?.title) ||
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
    (typeof session?.modified === "string" &&
      normalizeSessionValue(session.modified)) ||
    (typeof session?.subtitle === "string" &&
      normalizeSessionValue(session.subtitle));
  if (text) return text;
  const normalized = normalizeBoundSessionListItem(session);
  return normalized ? normalized.modified.toISOString() : undefined;
}

export function isActiveBoundSession(session: any, activePath?: string): boolean {
  const normalized = normalizeBoundSessionListItem(session);
  const targetPath = normalizeSessionValue(activePath);
  if (!normalized || !targetPath) return false;
  return path.resolve(normalized.path) === path.resolve(targetPath);
}
