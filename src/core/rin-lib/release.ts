import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseChannel = "stable" | "beta" | "git";

export type ReleaseRequest = {
  channel?: ReleaseChannel;
  branch?: string;
  version?: string;
};

export type ReleaseManifest = {
  schemaVersion?: number;
  packageName?: string;
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

export type InstalledReleaseInfo = ResolvedRelease & {
  installedAt?: string;
};

const DEFAULT_PACKAGE_NAME = "@rinchanai/rin";
const DEFAULT_REPO_URL = "https://github.com/rinchanai/rin";
const DEFAULT_BOOTSTRAP_BRANCH = "stable-bootstrap";
const DEFAULT_STABLE_VERSION = "0.0.0";
const DEFAULT_BETA_BRANCH = "release/next";
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

export function buildGitHubRefArchiveUrl(repoUrl: string, ref: string) {
  const normalizedRepo = trimReleaseValue(repoUrl).replace(/\.git$/i, "");
  const normalizedRef = trimReleaseValue(ref) || "main";
  const encodedSegments = normalizedRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedRepo}/archive/${encodedSegments}.tar.gz`;
}

export function buildGitHubBranchArchiveUrl(repoUrl: string, branch: string) {
  return buildGitHubRefArchiveUrl(repoUrl, `refs/heads/${branch}`);
}

export function buildNpmTarballUrl(packageName: string, version: string) {
  const normalizedName = trimReleaseValue(packageName) || DEFAULT_PACKAGE_NAME;
  const normalizedVersion = trimReleaseValue(version) || DEFAULT_STABLE_VERSION;
  const encodedName = encodeURIComponent(normalizedName);
  const fileBase = normalizedName.split("/").pop() || normalizedName;
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${normalizedVersion}.tgz`;
}

function defaultReleaseManifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    packageName: DEFAULT_PACKAGE_NAME,
    repoUrl: DEFAULT_REPO_URL,
    bootstrapBranch: DEFAULT_BOOTSTRAP_BRANCH,
    stable: {
      version: DEFAULT_STABLE_VERSION,
      archiveUrl: buildGitHubBranchArchiveUrl(DEFAULT_REPO_URL, "main"),
    },
    beta: {
      defaultBranch: DEFAULT_BETA_BRANCH,
      branches: {
        [DEFAULT_BETA_BRANCH]: {
          version: DEFAULT_BETA_VERSION,
          archiveUrl: buildGitHubBranchArchiveUrl(DEFAULT_REPO_URL, "main"),
        },
      },
      versions: {
        [DEFAULT_BETA_VERSION]: {
          branch: DEFAULT_BETA_BRANCH,
          archiveUrl: buildGitHubBranchArchiveUrl(DEFAULT_REPO_URL, "main"),
        },
      },
    },
    git: {
      defaultBranch: "main",
      repoUrl: DEFAULT_REPO_URL,
    },
  };
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
    return defaultReleaseManifest();
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

export function getReleasePackageName(manifest?: ReleaseManifest) {
  return (
    trimReleaseValue(process.env.RIN_NPM_PACKAGE) ||
    trimReleaseValue(manifest?.packageName) ||
    DEFAULT_PACKAGE_NAME
  );
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
  const packageName = getReleasePackageName(manifest);

  if (branch && version) {
    throw new Error("rin_release_branch_and_version_conflict");
  }

  if (channel === "stable") {
    if (branch) throw new Error("rin_stable_branch_not_supported");
    const explicit = version ? manifest.stable?.versions?.[version] : undefined;
    const resolvedVersion =
      version || trimReleaseValue(manifest.stable?.version) || DEFAULT_STABLE_VERSION;
    const archiveUrl =
      trimReleaseValue(explicit?.archiveUrl) ||
      trimReleaseValue(manifest.stable?.archiveUrl) ||
      buildNpmTarballUrl(packageName, resolvedVersion);
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
        DEFAULT_BETA_BRANCH;
      return {
        channel,
        archiveUrl:
          trimReleaseValue(entry?.archiveUrl) ||
          buildGitHubRefArchiveUrl(repoUrl, version),
        version,
        branch: resolvedBranch,
        ref: version,
        sourceLabel: `beta version ${version}`,
      };
    }
    const resolvedBranch = branch || trimReleaseValue(beta.defaultBranch) || DEFAULT_BETA_BRANCH;
    const entry = beta.branches?.[resolvedBranch];
    return {
      channel,
      archiveUrl:
        trimReleaseValue(entry?.archiveUrl) ||
        buildGitHubBranchArchiveUrl(repoUrl, resolvedBranch),
      version: trimReleaseValue(entry?.version) || DEFAULT_BETA_VERSION,
      branch: resolvedBranch,
      ref: resolvedBranch,
      sourceLabel: `beta branch ${resolvedBranch}`,
    };
  }

  const gitRepoUrl = trimReleaseValue(manifest.git?.repoUrl) || repoUrl;
  const resolvedBranch =
    branch || trimReleaseValue(manifest.git?.defaultBranch) || "main";
  const resolvedRef = version || resolvedBranch;
  return {
    channel,
    archiveUrl: version
      ? buildGitHubRefArchiveUrl(gitRepoUrl, resolvedRef)
      : buildGitHubBranchArchiveUrl(gitRepoUrl, resolvedBranch),
    version: version || resolvedRef,
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: version ? `git ref ${resolvedRef}` : `git branch ${resolvedRef}`,
  };
}

export async function fetchReleaseManifest(
  manifestUrl?: string,
  fallbackManifestUrl?: string,
): Promise<ReleaseManifest> {
  const urls = [
    trimReleaseValue(manifestUrl || process.env.RIN_RELEASE_MANIFEST_URL),
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
  return {
    primary: `${rawBase}/${bootstrapBranch}/release-manifest.json`,
    fallback: `${rawBase}/main/release-manifest.json`,
  };
}

export async function loadReleaseManifestForNetwork(sourceRoot?: string) {
  const bundled = readBundledReleaseManifest(sourceRoot);
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
  if (!version && !branch && !ref && !sourceLabel && !archiveUrl) return undefined;
  return {
    channel,
    version: version || ref || branch || "unknown",
    branch: branch || (channel === "stable" ? "stable" : "main"),
    ref: ref || branch || version || "main",
    sourceLabel:
      sourceLabel || `${channel} ${version || branch || ref || "unknown"}`,
    archiveUrl,
    installedAt: new Date().toISOString(),
  };
}
