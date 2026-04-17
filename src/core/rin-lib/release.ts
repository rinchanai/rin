import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimeProfile } from "./runtime.js";

export type ReleaseChannel = "stable" | "beta" | "git";

export type ReleaseRequest = {
  channel?: ReleaseChannel;
  branch?: string;
  version?: string;
};

export type ReleaseManifest = {
  schemaVersion?: number;
  repoUrl?: string;
  bootstrapBranch?: string;
  stable?: {
    version?: string;
    archiveUrl?: string;
    versions?: Record<string, { archiveUrl?: string }>;
  };
  beta?: {
    defaultBranch?: string;
    branches?: Record<string, { version?: string; archiveUrl?: string }>;
    versions?: Record<string, { branch?: string; archiveUrl?: string }>;
  };
  git?: {
    defaultBranch?: string;
    repoUrl?: string;
  };
};

export type ResolvedRelease = {
  channel: ReleaseChannel;
  archiveUrl: string;
  version: string;
  branch: string;
  ref: string;
  sourceLabel: string;
};

export type InstalledReleaseInfo = {
  channel: ReleaseChannel;
  version: string;
  branch: string;
  ref: string;
  sourceLabel: string;
  archiveUrl: string;
  installedAt?: string;
};

const DEFAULT_REPO_URL = "https://github.com/rinchanai/rin";
const DEFAULT_BOOTSTRAP_BRANCH = "stable-bootstrap";
const DEFAULT_STABLE_VERSION = "0.0.0";
const DEFAULT_BETA_VERSION = "0.0.0-beta.0";

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function trimReleaseValue(value: unknown) {
  return safeString(value).trim();
}

function resolveModuleRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

export function getBundledReleaseManifestPath(sourceRoot?: string) {
  const root = trimReleaseValue(sourceRoot) || resolveModuleRootFromHere();
  return path.join(root, "release-manifest.json");
}

export function readBundledReleaseManifest(sourceRoot?: string): ReleaseManifest {
  const manifestPath = getBundledReleaseManifestPath(sourceRoot);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  } catch {
    return {
      schemaVersion: 1,
      repoUrl: DEFAULT_REPO_URL,
      bootstrapBranch: DEFAULT_BOOTSTRAP_BRANCH,
      stable: {
        version: DEFAULT_STABLE_VERSION,
        archiveUrl: buildGitHubArchiveUrl(DEFAULT_REPO_URL, "main"),
      },
      beta: {
        defaultBranch: "release/next",
        branches: {
          "release/next": {
            version: DEFAULT_BETA_VERSION,
            archiveUrl: buildGitHubArchiveUrl(DEFAULT_REPO_URL, "main"),
          },
        },
      },
      git: {
        defaultBranch: "main",
        repoUrl: DEFAULT_REPO_URL,
      },
    } satisfies ReleaseManifest;
  }
}

export function getBootstrapBranch(manifest?: ReleaseManifest) {
  return (
    trimReleaseValue(process.env.RIN_BOOTSTRAP_BRANCH) ||
    trimReleaseValue(manifest?.bootstrapBranch) ||
    DEFAULT_BOOTSTRAP_BRANCH
  );
}

export function getReleaseRepoUrl(manifest?: ReleaseManifest) {
  return (
    trimReleaseValue(process.env.RIN_INSTALL_REPO_URL) ||
    trimReleaseValue(manifest?.repoUrl) ||
    DEFAULT_REPO_URL
  );
}

export function buildGitHubArchiveUrl(repoUrl: string, ref: string) {
  const normalizedRepo = trimReleaseValue(repoUrl).replace(/\.git$/i, "");
  const normalizedRef = trimReleaseValue(ref) || "main";
  const encodedSegments = normalizedRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedRepo}/archive/${encodedSegments}.tar.gz`;
}

function normalizeReleaseChannel(requested: unknown): ReleaseChannel {
  const text = trimReleaseValue(requested).toLowerCase();
  if (text === "beta" || text === "git") return text;
  return "stable";
}

export function resolveReleaseRequest(
  manifest: ReleaseManifest,
  request: ReleaseRequest = {},
): ResolvedRelease {
  const channel = normalizeReleaseChannel(request.channel);
  const branch = trimReleaseValue(request.branch);
  const version = trimReleaseValue(request.version);
  const repoUrl = getReleaseRepoUrl(manifest);

  if (branch && version) {
    throw new Error("rin_release_branch_and_version_conflict");
  }

  if (channel === "stable") {
    if (branch) throw new Error("rin_stable_branch_not_supported");
    const explicit = manifest.stable?.versions?.[version];
    const resolvedVersion =
      version || trimReleaseValue(manifest.stable?.version) || DEFAULT_STABLE_VERSION;
    const archiveUrl =
      trimReleaseValue(explicit?.archiveUrl) ||
      trimReleaseValue(manifest.stable?.archiveUrl) ||
      buildGitHubArchiveUrl(repoUrl, version || "main");
    return {
      channel,
      archiveUrl,
      version: resolvedVersion,
      branch: "stable",
      ref: version || trimReleaseValue(manifest.stable?.version) || "main",
      sourceLabel: version
        ? `stable version ${resolvedVersion}`
        : `stable ${resolvedVersion}`,
    };
  }

  if (channel === "beta") {
    const beta = manifest.beta || {};
    if (version) {
      const entry = beta.versions?.[version];
      const resolvedBranch =
        trimReleaseValue(entry?.branch) ||
        trimReleaseValue(beta.defaultBranch) ||
        "release/next";
      return {
        channel,
        archiveUrl:
          trimReleaseValue(entry?.archiveUrl) ||
          buildGitHubArchiveUrl(repoUrl, version),
        version,
        branch: resolvedBranch,
        ref: version,
        sourceLabel: `beta version ${version}`,
      };
    }
    const resolvedBranch = branch || trimReleaseValue(beta.defaultBranch) || "release/next";
    const entry = beta.branches?.[resolvedBranch];
    return {
      channel,
      archiveUrl:
        trimReleaseValue(entry?.archiveUrl) ||
        buildGitHubArchiveUrl(repoUrl, resolvedBranch),
      version:
        trimReleaseValue(entry?.version) ||
        DEFAULT_BETA_VERSION,
      branch: resolvedBranch,
      ref: resolvedBranch,
      sourceLabel: `beta branch ${resolvedBranch}`,
    };
  }

  const gitRepoUrl = trimReleaseValue(manifest.git?.repoUrl) || repoUrl;
  const resolvedRef =
    version || branch || trimReleaseValue(manifest.git?.defaultBranch) || "main";
  return {
    channel,
    archiveUrl: buildGitHubArchiveUrl(gitRepoUrl, resolvedRef),
    version: version || resolvedRef,
    branch: branch || trimReleaseValue(manifest.git?.defaultBranch) || "main",
    ref: resolvedRef,
    sourceLabel: version
      ? `git ref ${resolvedRef}`
      : `git branch ${resolvedRef}`,
  };
}

export async function fetchReleaseManifest(
  manifestUrl?: string,
  fallbackManifestUrl?: string,
): Promise<ReleaseManifest> {
  const explicitUrl = trimReleaseValue(manifestUrl || process.env.RIN_RELEASE_MANIFEST_URL);
  const urls = [
    explicitUrl,
    trimReleaseValue(fallbackManifestUrl),
  ].filter(Boolean);
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      return (await response.json()) as ReleaseManifest;
    } catch {}
  }
  return readBundledReleaseManifest();
}

function getBootstrapManifestUrls(manifest?: ReleaseManifest) {
  const repoUrl = getReleaseRepoUrl(manifest);
  const bootstrapBranch = getBootstrapBranch(manifest);
  const rawBase = repoUrl
    .replace(/^https?:\/\/github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/\.git$/i, "");
  const primary = `${rawBase}/${bootstrapBranch}/release-manifest.json`;
  const fallback = `${rawBase}/main/release-manifest.json`;
  return { primary, fallback };
}

export async function loadReleaseManifestForNetwork() {
  const bundled = readBundledReleaseManifest();
  const { primary, fallback } = getBootstrapManifestUrls(bundled);
  return await fetchReleaseManifest(primary, fallback);
}

export function releaseInfoFromEnv(): InstalledReleaseInfo | undefined {
  const channel = normalizeReleaseChannel(process.env.RIN_RELEASE_CHANNEL);
  const version = trimReleaseValue(process.env.RIN_RELEASE_VERSION);
  const branch = trimReleaseValue(process.env.RIN_RELEASE_BRANCH);
  const ref = trimReleaseValue(process.env.RIN_RELEASE_REF || branch || version);
  const sourceLabel = trimReleaseValue(process.env.RIN_RELEASE_SOURCE_LABEL);
  const archiveUrl = trimReleaseValue(process.env.RIN_RELEASE_ARCHIVE_URL);
  if (!version && !branch && !ref && !archiveUrl) return undefined;
  return {
    channel,
    version: version || ref || branch || "unknown",
    branch: branch || (channel === "stable" ? "stable" : "main"),
    ref: ref || branch || version || "main",
    sourceLabel:
      sourceLabel ||
      `${channel} ${version || branch || ref || "unknown"}`,
    archiveUrl,
    installedAt: new Date().toISOString(),
  };
}

export function readInstalledReleaseInfo(agentDir?: string): InstalledReleaseInfo | undefined {
  const profile = resolveRuntimeProfile({ agentDir });
  const manifestPath = path.join(profile.agentDir, "installer.json");
  try {
    const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as any;
    const release = manifestJson?.release;
    if (!release || typeof release !== "object") return undefined;
    const channel = normalizeReleaseChannel(release.channel);
    const version = trimReleaseValue(release.version);
    const branch = trimReleaseValue(release.branch);
    const ref = trimReleaseValue(release.ref);
    const sourceLabel = trimReleaseValue(release.sourceLabel);
    const archiveUrl = trimReleaseValue(release.archiveUrl);
    if (!version && !branch && !ref && !archiveUrl) return undefined;
    return {
      channel,
      version: version || ref || branch || "unknown",
      branch: branch || (channel === "stable" ? "stable" : "main"),
      ref: ref || branch || version || "main",
      sourceLabel:
        sourceLabel || `${channel} ${version || branch || ref || "unknown"}`,
      archiveUrl,
      installedAt: trimReleaseValue(release.installedAt) || undefined,
    };
  } catch {
    return undefined;
  }
}
