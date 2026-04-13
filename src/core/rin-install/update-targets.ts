import fs from "node:fs";
import path from "node:path";

type UpdateTargetDiscoveryDeps = {
  roots?: string[];
  readdirSync?: typeof fs.readdirSync;
  readFileSync?: typeof fs.readFileSync;
};

function readJsonFile<T>(
  filePath: string,
  fallback: T,
  deps: Pick<UpdateTargetDiscoveryDeps, "readFileSync"> = {},
): T {
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export type InstalledTarget = {
  targetUser: string;
  installDir: string;
  ownerHome: string;
  source: "manifest" | "systemd" | "launchd";
};

export function discoverInstalledTargets(deps: UpdateTargetDiscoveryDeps = {}) {
  const rows: InstalledTarget[] = [];
  const seen = new Set<string>();
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const readdirSync = deps.readdirSync ?? fs.readdirSync;
  const roots =
    Array.isArray(deps.roots) && deps.roots.length
      ? deps.roots
      : ["/home", "/Users"];

  const add = (
    targetUser: string,
    installDir: string,
    ownerHome: string,
    source: InstalledTarget["source"],
  ) => {
    const nextTargetUser = String(targetUser || "").trim();
    const nextInstallDir = String(installDir || "").trim();
    const nextOwnerHome = String(ownerHome || "").trim();
    if (!nextTargetUser || !nextInstallDir || !nextOwnerHome) return;
    const key = `${nextTargetUser}\t${nextInstallDir}\t${nextOwnerHome}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      targetUser: nextTargetUser,
      installDir: nextInstallDir,
      ownerHome: nextOwnerHome,
      source,
    });
  };

  const scanHome = (homeDir: string) => {
    const userName = path.basename(homeDir);
    const manifestPath = path.join(homeDir, ".rin", "installer.json");
    const legacyManifestPath = path.join(
      homeDir,
      ".rin",
      "config",
      "installer.json",
    );
    const manifest = readJsonFile<any>(
      manifestPath,
      readJsonFile<any>(legacyManifestPath, null, { readFileSync }),
      { readFileSync },
    );
    if (manifest && typeof manifest === "object") {
      add(
        String(manifest.targetUser || userName),
        String(manifest.installDir || path.join(homeDir, ".rin")),
        homeDir,
        "manifest",
      );
    }

    const systemdDir = path.join(homeDir, ".config", "systemd", "user");
    try {
      for (const entry of readdirSync(systemdDir)) {
        if (!/^rin-daemon(?:-.+)?\.service$/.test(String(entry))) continue;
        const filePath = path.join(systemdDir, String(entry));
        const text = readFileSync(filePath, "utf8");
        const match = text.match(/^Environment=RIN_DIR=(.+)$/m);
        add(
          userName,
          match ? match[1].trim() : path.join(homeDir, ".rin"),
          homeDir,
          "systemd",
        );
      }
    } catch {}

    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    try {
      for (const entry of readdirSync(launchAgentsDir)) {
        if (!/^com\.rin\.daemon\..+\.plist$/.test(String(entry))) continue;
        const filePath = path.join(launchAgentsDir, String(entry));
        const text = readFileSync(filePath, "utf8");
        const match = text.match(
          /<key>RIN_DIR<\/key>\s*<string>([^<]+)<\/string>/,
        );
        add(
          userName,
          match ? match[1].trim() : path.join(homeDir, ".rin"),
          homeDir,
          "launchd",
        );
      }
    } catch {}
  };

  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true } as any)) {
        const nextEntry = entry as any;
        if (typeof nextEntry === "string") continue;
        if (!nextEntry?.isDirectory?.()) continue;
        scanHome(path.join(root, String(nextEntry.name || "")));
      }
    } catch {}
  }

  return rows.sort(
    (a, b) =>
      a.targetUser.localeCompare(b.targetUser) ||
      a.installDir.localeCompare(b.installDir) ||
      a.ownerHome.localeCompare(b.ownerHome),
  );
}
