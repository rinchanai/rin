#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    manifest: "release-manifest.json",
    channel: "stable",
    branch: "",
    version: "",
    packageName: "",
    repoUrl: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = String(argv[++index] || "").trim();
    else if (arg === "--channel") args.channel = String(argv[++index] || "").trim();
    else if (arg === "--branch") args.branch = String(argv[++index] || "").trim();
    else if (arg === "--version") args.version = String(argv[++index] || "").trim();
    else if (arg === "--package-name") args.packageName = String(argv[++index] || "").trim();
    else if (arg === "--repo-url") args.repoUrl = String(argv[++index] || "").trim();
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/release/update-release-manifest.mjs --channel stable|beta [--branch <release/x.y>] --version <x.y.z> [--package-name <name>] [--repo-url <url>] [--manifest <path>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function trim(value) {
  return String(value || "").trim();
}

function buildNpmTarballUrl(packageName, version) {
  const encodedName = encodeURIComponent(packageName);
  const fileBase = packageName.split("/").pop();
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${version}.tgz`;
}

function buildGitHubBranchArchiveUrl(repoUrl, branch) {
  const normalizedRepo = trim(repoUrl).replace(/\.git$/i, "");
  const normalizedBranch = trim(branch) || "main";
  const encodedBranch = normalizedBranch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedRepo}/archive/refs/heads/${encodedBranch}.tar.gz`;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(process.cwd(), args.manifest);
const manifest = readJson(manifestPath);
const channel = trim(args.channel || "stable");
const version = trim(args.version);
const branch = trim(args.branch);
const packageName =
  trim(args.packageName) ||
  trim(process.env.RIN_NPM_PACKAGE) ||
  trim(manifest.packageName) ||
  "@rinchanai/rin";
const repoUrl =
  trim(args.repoUrl) ||
  trim(process.env.RIN_RELEASE_REPO_URL || process.env.RIN_INSTALL_REPO_URL) ||
  trim(manifest.repoUrl) ||
  "https://github.com/rinchanai/rin";

if (!version) throw new Error("missing_version");
if (channel !== "stable" && channel !== "beta") {
  throw new Error(`unsupported_channel:${channel}`);
}
if (channel === "beta" && !branch) {
  throw new Error("beta_requires_branch");
}

manifest.schemaVersion = 1;
manifest.packageName = packageName;
manifest.repoUrl = repoUrl;
manifest.bootstrapBranch = trim(manifest.bootstrapBranch) || "stable-bootstrap";
manifest.stable ||= {};
manifest.beta ||= { defaultBranch: "release/next", branches: {}, versions: {} };
manifest.beta.branches ||= {};
manifest.beta.versions ||= {};
manifest.git ||= {};
manifest.git.defaultBranch = trim(manifest.git.defaultBranch) || "main";
manifest.git.repoUrl = trim(manifest.git.repoUrl) || repoUrl;

if (channel === "stable") {
  const archiveUrl = buildNpmTarballUrl(packageName, version);
  manifest.stable.version = version;
  manifest.stable.archiveUrl = archiveUrl;
  manifest.stable.versions ||= {};
  manifest.stable.versions[version] = { archiveUrl };
} else {
  const archiveUrl = buildGitHubBranchArchiveUrl(repoUrl, branch);
  if (!trim(manifest.beta.defaultBranch)) manifest.beta.defaultBranch = branch;
  manifest.beta.branches[branch] = {
    version,
    archiveUrl,
  };
  manifest.beta.versions[version] = {
    branch,
    archiveUrl,
  };
}

writeJson(manifestPath, manifest);
console.log(`Updated ${path.relative(process.cwd(), manifestPath)} for ${channel} ${version}.`);
