import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import {
  DEFAULT_SESSION_DISPLAY_NAME,
  resolveSessionDisplayName,
} from "./names.js";

export type BoundSessionListItem = {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: Date;
};

export type BoundSessionListPresentation = BoundSessionListItem & {
  title: string;
  subtitle?: string;
  isActive: boolean;
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

function firstNormalizedSessionText(...values: unknown[]) {
  for (const value of values) {
    const text = normalizeSessionValue(value);
    if (text) return text;
  }
  return "";
}

function normalizeModified(value: unknown, fallback?: unknown) {
  const candidate =
    value instanceof Date
      ? value
      : new Date(firstNormalizedSessionText(value, fallback) || Date.now());
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

export function normalizeBoundSessionListItem(
  session: any,
): BoundSessionListItem | null {
  if (isBoundSessionListItem(session)) return session;
  const sessionPath = firstNormalizedSessionText(session?.path, session?.id);
  if (!sessionPath) return null;
  const id = firstNormalizedSessionText(session?.id, sessionPath);
  return {
    id,
    path: sessionPath,
    name: normalizeSessionValue(session?.name),
    firstMessage: firstNormalizedSessionText(
      session?.firstMessage,
      session?.title,
      id,
      DEFAULT_SESSION_DISPLAY_NAME,
    ),
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

function resolveBoundSessionDisplayTitle(
  session: BoundSessionListItem | null | undefined,
): string {
  return (
    resolveSessionDisplayName({
      currentName: session?.name,
      firstUserMessage: session?.firstMessage,
    }) || DEFAULT_SESSION_DISPLAY_NAME
  );
}

function resolveBoundSessionSubtitle(
  session: any,
  normalized: BoundSessionListItem | null | undefined,
): string | undefined {
  const text = firstNormalizedSessionText(
    typeof session?.modified === "string" ? session.modified : "",
    typeof session?.subtitle === "string" ? session.subtitle : "",
  );
  return text || normalized?.modified.toISOString();
}

function isNormalizedBoundSessionActive(
  session: BoundSessionListItem | null | undefined,
  normalizedActivePath?: string,
): boolean {
  if (!session || !normalizedActivePath) return false;
  return path.resolve(session.path) === path.resolve(normalizedActivePath);
}

function presentNormalizedBoundSession(
  session: BoundSessionListItem,
  normalizedActivePath?: string,
): BoundSessionListPresentation {
  return {
    ...session,
    title: resolveBoundSessionDisplayTitle(session),
    subtitle: session.modified.toISOString(),
    isActive: isNormalizedBoundSessionActive(session, normalizedActivePath),
  };
}

export function describeBoundSession(
  session: any,
  activePath?: string,
): BoundSessionListPresentation | null {
  const normalized = normalizeBoundSessionListItem(session);
  if (!normalized) return null;
  const normalizedActivePath = normalizeSessionValue(activePath);
  return {
    ...presentNormalizedBoundSession(normalized, normalizedActivePath),
    subtitle: resolveBoundSessionSubtitle(session, normalized),
  };
}

export function describeBoundSessions(
  sessions: any,
  activePath?: string,
): BoundSessionListPresentation[] {
  const normalizedActivePath = normalizeSessionValue(activePath);
  return normalizeBoundSessionList(sessions).map((session) =>
    presentNormalizedBoundSession(session, normalizedActivePath),
  );
}

export function getBoundSessionDisplayTitle(session: any): string {
  return resolveBoundSessionDisplayTitle(normalizeBoundSessionListItem(session));
}

export function getBoundSessionSubtitle(session: any): string | undefined {
  return describeBoundSession(session)?.subtitle;
}

export function isActiveBoundSession(session: any, activePath?: string): boolean {
  return describeBoundSession(session, activePath)?.isActive || false;
}
