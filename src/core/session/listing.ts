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

type BoundSessionSource = {
  id?: unknown;
  path?: unknown;
  name?: unknown;
  firstMessage?: unknown;
  title?: unknown;
  modified?: unknown;
  subtitle?: unknown;
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

function getBoundSessionSource(value: unknown): BoundSessionSource | undefined {
  return value && typeof value === "object"
    ? (value as BoundSessionSource)
    : undefined;
}

function normalizeSessionText(...values: unknown[]): string {
  for (const value of values) {
    const text = normalizeSessionValue(value);
    if (text) return text;
  }
  return "";
}

function normalizeSessionDate(value: unknown): Date | undefined {
  const candidate =
    value instanceof Date ? value : new Date(normalizeSessionText(value));
  return Number.isFinite(candidate.getTime()) ? candidate : undefined;
}

function resolveNormalizedSessionPath(sessionPath: string): string {
  return path.resolve(sessionPath);
}

function resolveBoundSessionModified(session: BoundSessionSource | undefined): Date {
  return (
    normalizeSessionDate(session?.modified) ||
    normalizeSessionDate(session?.subtitle) ||
    new Date()
  );
}

function resolveBoundSessionSubtitle(
  session: BoundSessionSource | undefined,
  normalized: BoundSessionListItem,
): string {
  const normalizedSubtitle =
    normalizeSessionDate(session?.modified)?.toISOString() ||
    normalizeSessionDate(session?.subtitle)?.toISOString();
  if (normalizedSubtitle) return normalizedSubtitle;
  return (
    normalizeSessionValue(
      typeof session?.subtitle === "string" ? session.subtitle : undefined,
    ) || normalized.modified.toISOString()
  );
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

function isNormalizedBoundSessionActive(
  session: BoundSessionListItem,
  normalizedActivePath?: string,
): boolean {
  return Boolean(
    normalizedActivePath &&
      resolveNormalizedSessionPath(session.path) ===
        resolveNormalizedSessionPath(normalizedActivePath),
  );
}

function describeNormalizedBoundSession(
  session: BoundSessionListItem,
  activePath?: string,
  subtitle = session.modified.toISOString(),
): BoundSessionListPresentation {
  const normalizedActivePath = normalizeSessionValue(activePath);
  return {
    ...session,
    title: resolveBoundSessionDisplayTitle(session),
    subtitle,
    isActive: isNormalizedBoundSessionActive(session, normalizedActivePath),
  };
}

export function normalizeBoundSessionListItem(
  session: unknown,
): BoundSessionListItem | null {
  if (isBoundSessionListItem(session)) return session;
  const source = getBoundSessionSource(session);
  const sessionPath = normalizeSessionText(source?.path, source?.id);
  if (!sessionPath) return null;
  const id = normalizeSessionText(source?.id, sessionPath);
  return {
    id,
    path: sessionPath,
    name: normalizeSessionValue(source?.name),
    firstMessage: normalizeSessionText(source?.firstMessage, source?.title, id),
    modified: resolveBoundSessionModified(source),
  };
}

export function normalizeBoundSessionList(sessions: unknown): BoundSessionListItem[] {
  const seen = new Set<string>();
  return (Array.isArray(sessions) ? sessions : [])
    .map(normalizeBoundSessionListItem)
    .filter((item): item is BoundSessionListItem => Boolean(item))
    .filter((item) => {
      const resolvedPath = resolveNormalizedSessionPath(item.path);
      if (seen.has(resolvedPath)) return false;
      seen.add(resolvedPath);
      return true;
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function describeBoundSession(
  session: unknown,
  activePath?: string,
): BoundSessionListPresentation | null {
  const normalized = normalizeBoundSessionListItem(session);
  if (!normalized) return null;
  return describeNormalizedBoundSession(
    normalized,
    activePath,
    resolveBoundSessionSubtitle(getBoundSessionSource(session), normalized),
  );
}

export function describeBoundSessions(
  sessions: unknown,
  activePath?: string,
): BoundSessionListPresentation[] {
  return normalizeBoundSessionList(sessions).map((session) =>
    describeNormalizedBoundSession(session, activePath),
  );
}

export function getBoundSessionDisplayTitle(session: unknown): string {
  return resolveBoundSessionDisplayTitle(
    normalizeBoundSessionListItem(session),
  );
}

export function getBoundSessionSubtitle(session: unknown): string | undefined {
  return describeBoundSession(session)?.subtitle;
}

export function isActiveBoundSession(
  session: unknown,
  activePath?: string,
): boolean {
  return describeBoundSession(session, activePath)?.isActive || false;
}
