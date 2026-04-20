#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    manifest: "release-manifest.json",
    channel: "",
    betaVersion: "",
    ref: "",
    date: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = String(argv[++index] || "").trim();
    else if (arg === "--channel") args.channel = String(argv[++index] || "").trim();
    else if (arg === "--beta-version") args.betaVersion = String(argv[++index] || "").trim();
    else if (arg === "--ref") args.ref = String(argv[++index] || "").trim();
    else if (arg === "--date") args.date = String(argv[++index] || "").trim();
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/release/plan-release.mjs --channel nightly|beta|stable-promotion [--manifest <path>] [--ref <sha>] [--beta-version <x.y.z-beta...>] [--date <YYYYMMDD>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return args;
}

function trim(value) {
  return String(value || "").trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function todayUtc() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function parseCore(version) {
  const match = trim(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatCore(core) {
  return `${core.major}.${core.minor}.${core.patch}`;
}

function compareCore(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function stripPrerelease(version) {
  return trim(version).replace(/[-+].*$/, "") || "0.0.0";
}

function incrementPatch(version) {
  const core = parseCore(version);
  return formatCore({ ...core, patch: core.patch + 1 });
}

function resolveSeries(manifest) {
  const configured = trim(manifest.train?.series);
  if (configured) return configured;
  const stable = parseCore(trim(manifest.stable?.version) || "0.0.0");
  return `${stable.major}.${stable.minor}`;
}

function nextPromotionVersion(manifest) {
  const series = resolveSeries(manifest);
  const [seriesMajor, seriesMinor] = series.split(".").map((value) => Number(value || 0));
  const stableCore = parseCore(trim(manifest.stable?.version) || "0.0.0");
  if (stableCore.major === seriesMajor && stableCore.minor === seriesMinor) {
    return `${seriesMajor}.${seriesMinor}.${stableCore.patch + 1}`;
  }
  return `${seriesMajor}.${seriesMinor}.0`;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(process.cwd(), args.manifest);
const manifest = readJson(manifestPath);
const channel = trim(args.channel);
const date = trim(args.date) || todayUtc();
const ref = trim(args.ref);
const shortRef = trim(ref).slice(0, 7) || "main";

let result;
if (channel === "nightly") {
  const promotionVersion = nextPromotionVersion(manifest);
  result = {
    series: resolveSeries(manifest),
    promotionVersion,
    version: `${promotionVersion}-nightly.${date}+${shortRef}`,
  };
} else if (channel === "beta") {
  const promotionVersion = nextPromotionVersion(manifest);
  result = {
    series: resolveSeries(manifest),
    promotionVersion,
    version: `${promotionVersion}-beta.${date}`,
  };
} else if (channel === "stable-promotion") {
  const betaVersion = trim(args.betaVersion) || trim(manifest.beta?.version);
  if (!betaVersion) throw new Error("missing_beta_version");
  const basePromotionVersion = stripPrerelease(betaVersion);
  const currentStableVersion = trim(manifest.stable?.version) || "0.0.0";
  const targetVersion =
    compareCore(parseCore(basePromotionVersion), parseCore(currentStableVersion)) <= 0
      ? incrementPatch(currentStableVersion)
      : basePromotionVersion;
  result = {
    series: resolveSeries(manifest),
    promotionVersion: basePromotionVersion,
    version: targetVersion,
  };
} else {
  throw new Error(`unsupported_channel:${channel}`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
