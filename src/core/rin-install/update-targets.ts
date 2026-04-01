import fs from "node:fs";
import path from "node:path";

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
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

export function discoverInstalledTargets() {
  const rows: InstalledTarget[] = [];
  const seen = new Set<string>();

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
      readJsonFile<any>(legacyManifestPath, null),
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
      for (const entry of fs.readdirSync(systemdDir)) {
        if (!/^rin-daemon(?:-.+)?\.service$/.test(entry)) continue;
        const filePath = path.join(systemdDir, entry);
        const text = fs.readFileSync(filePath, "utf8");
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
      for (const entry of fs.readdirSync(launchAgentsDir)) {
        if (!/^com\.rin\.daemon\..+\.plist$/.test(entry)) continue;
        const filePath = path.join(launchAgentsDir, entry);
        const text = fs.readFileSync(filePath, "utf8");
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

  for (const root of ["/home", "/Users"]) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        scanHome(path.join(root, entry.name));
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
