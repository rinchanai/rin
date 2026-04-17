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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") args.manifest = String(argv[++i] || "").trim();
    else if (arg === "--channel") args.channel = String(argv[++i] || "").trim();
    else if (arg === "--branch") args.branch = String(argv[++i] || "").trim();
    else if (arg === "--version") args.version = String(argv[++i] || "").trim();
    else if (arg === "--package-name") args.packageName = String(argv[++i] || "").trim();
    else if (arg === "--repo-url") args.repoUrl = String(argv[++i] || "").trim();
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

function npmTarballUrl(packageName, version) {
  const encoded = encodeURIComponent(packageName);
  const fileBase = packageName.split("/").pop();
  return `https://registry.npmjs.org/${encoded}/-/${fileBase}-${version}.tgz`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(process.cwd(), args.manifest);
const manifest = readJson(manifestPath);
const packageName =
  args.packageName ||
  String(process.env.RIN_NPM_PACKAGE || manifest.packageName || "@rinchanai/rin").trim();
const repoUrl =
  args.repoUrl ||
  String(process.env.RIN_RELEASE_REPO_URL || manifest.repoUrl || "https://github.com/rinchanai/rin").trim();
const channel = String(args.channel || "stable").trim();
const version = String(args.version || "").trim();
const branch = String(args.branch || "").trim();

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
manifest.bootstrapBranch = String(manifest.bootstrapBranch || "stable-bootstrap");
manifest.git ||= {};
manifest.git.defaultBranch = String(manifest.git.defaultBranch || "main");
manifest.stable ||= {};
manifest.beta ||= { defaultBranch: "release/next", branches: {}, versions: {} };
manifest.beta.branches ||= {};
manifest.beta.versions ||= {};

if (channel === "stable") {
  manifest.stable.version = version;
  manifest.stable.archiveUrl = npmTarballUrl(packageName, version);
  manifest.stable.versions ||= {};
  manifest.stable.versions[version] = {
    archiveUrl: npmTarballUrl(packageName, version),
  };
} else {
  manifest.beta.defaultBranch ||= branch;
  manifest.beta.branches[branch] = {
    version,
    archiveUrl: npmTarballUrl(packageName, version),
  };
  manifest.beta.versions[version] = {
    branch,
    archiveUrl: npmTarballUrl(packageName, version),
  };
}

writeJson(manifestPath, manifest);
console.log(`Updated ${path.relative(process.cwd(), manifestPath)} for ${channel} ${version}.`);
