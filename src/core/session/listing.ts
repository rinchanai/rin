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

type NormalizedBoundSessionDetails = {
  item: BoundSessionListItem;
  source?: BoundSessionSource;
  resolvedPath: string;
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

function resolveActiveSessionPath(activePath?: string): string | undefined {
  const normalizedActivePath = normalizeSessionValue(activePath);
  return normalizedActivePath
    ? resolveNormalizedSessionPath(normalizedActivePath)
    : undefined;
}

function resolveBoundSessionModified(
  session: BoundSessionSource | undefined,
): Date {
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

function normalizeBoundSessionDetails(
  session: unknown,
): NormalizedBoundSessionDetails | null {
  if (isBoundSessionListItem(session)) {
    return {
      item: session,
      source: getBoundSessionSource(session),
      resolvedPath: resolveNormalizedSessionPath(session.path),
    };
  }

  const source = getBoundSessionSource(session);
  const sessionPath = normalizeSessionText(source?.path, source?.id);
  if (!sessionPath) return null;

  const item = {
    id: normalizeSessionText(source?.id, sessionPath),
    path: sessionPath,
    name: normalizeSessionValue(source?.name),
    firstMessage: normalizeSessionText(
      source?.firstMessage,
      source?.title,
      sessionPath,
    ),
    modified: resolveBoundSessionModified(source),
  } satisfies BoundSessionListItem;

  return {
    item,
    source,
    resolvedPath: resolveNormalizedSessionPath(item.path),
  };
}

function normalizeBoundSessionDetailsList(
  sessions: unknown,
): NormalizedBoundSessionDetails[] {
  const seen = new Set<string>();
  return (Array.isArray(sessions) ? sessions : [])
    .map(normalizeBoundSessionDetails)
    .filter((details): details is NormalizedBoundSessionDetails =>
      Boolean(details),
    )
    .filter((details) => {
      if (seen.has(details.resolvedPath)) return false;
      seen.add(details.resolvedPath);
      return true;
    })
    .sort(
      (left, right) =>
        right.item.modified.getTime() - left.item.modified.getTime(),
    );
}

function isNormalizedBoundSessionActive(
  session: NormalizedBoundSessionDetails,
  normalizedActivePath?: string,
): boolean {
  return Boolean(
    normalizedActivePath && session.resolvedPath === normalizedActivePath,
  );
}

function describeNormalizedBoundSession(
  session: NormalizedBoundSessionDetails,
  normalizedActivePath?: string,
  subtitle = resolveBoundSessionSubtitle(session.source, session.item),
): BoundSessionListPresentation {
  return {
    ...session.item,
    title: resolveBoundSessionDisplayTitle(session.item),
    subtitle,
    isActive: isNormalizedBoundSessionActive(session, normalizedActivePath),
  };
}

export function normalizeBoundSessionListItem(
  session: unknown,
): BoundSessionListItem | null {
  return normalizeBoundSessionDetails(session)?.item || null;
}

export function normalizeBoundSessionList(
  sessions: unknown,
): BoundSessionListItem[] {
  return normalizeBoundSessionDetailsList(sessions).map(({ item }) => item);
}

export function describeBoundSession(
  session: unknown,
  activePath?: string,
): BoundSessionListPresentation | null {
  const normalized = normalizeBoundSessionDetails(session);
  if (!normalized) return null;
  return describeNormalizedBoundSession(
    normalized,
    resolveActiveSessionPath(activePath),
  );
}

export function describeBoundSessions(
  sessions: unknown,
  activePath?: string,
): BoundSessionListPresentation[] {
  const normalizedActivePath = resolveActiveSessionPath(activePath);
  return normalizeBoundSessionDetailsList(sessions).map((session) =>
    describeNormalizedBoundSession(session, normalizedActivePath),
  );
}

export function getBoundSessionDisplayTitle(session: unknown): string {
  return resolveBoundSessionDisplayTitle(
    normalizeBoundSessionDetails(session)?.item,
  );
}

export function getBoundSessionSubtitle(session: unknown): string | undefined {
  const normalized = normalizeBoundSessionDetails(session);
  return normalized
    ? resolveBoundSessionSubtitle(normalized.source, normalized.item)
    : undefined;
}

export function isActiveBoundSession(
  session: unknown,
  activePath?: string,
): boolean {
  const normalized = normalizeBoundSessionDetails(session);
  return normalized
    ? isNormalizedBoundSessionActive(
        normalized,
        resolveActiveSessionPath(activePath),
      )
    : false;
}
