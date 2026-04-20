import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { defaultDaemonSocketPath } from "./common.js";

function normalizeUserName(value: unknown) {
  return String(value || "").trim();
}

function defaultHomeForUser(targetUser: string) {
  return path.join(process.platform === "darwin" ? "/Users" : "/home", targetUser);
}

function readUnixUserId(targetUser: string) {
  const normalizedTargetUser = normalizeUserName(targetUser);
  if (!normalizedTargetUser || process.platform === "darwin") return -1;
  try {
    return Number(
      execFileSync("id", ["-u", normalizedTargetUser], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "-1",
    );
  } catch {
    return -1;
  }
}

export function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function pickPrivilegeCommand() {
  if (
    process.platform !== "win32" &&
    fs.existsSync("/run/current-system/sw/bin/doas")
  )
    return "/run/current-system/sw/bin/doas";
  if (process.platform !== "win32" && fs.existsSync("/usr/bin/doas"))
    return "/usr/bin/doas";
  if (process.platform !== "win32" && fs.existsSync("/bin/doas"))
    return "/bin/doas";
  if (process.platform !== "win32" && fs.existsSync("/usr/bin/sudo"))
    return "/usr/bin/sudo";
  if (process.platform !== "win32" && fs.existsSync("/bin/sudo"))
    return "/bin/sudo";
  if (process.platform !== "win32" && fs.existsSync("/usr/bin/pkexec"))
    return "/usr/bin/pkexec";
  return "sudo";
}

export function readPasswdUser(name: string) {
  const normalizedName = normalizeUserName(name);
  if (!normalizedName) return null;

  if (process.platform === "darwin") {
    try {
      const detail = execFileSync(
        "dscl",
        [
          ".",
          "-read",
          `/Users/${normalizedName}`,
          "NFSHomeDirectory",
          "UserShell",
        ],
        { encoding: "utf8" },
      );
      let home = "";
      let shell = "";
      for (const line of detail.split(/\r?\n/)) {
        if (line.startsWith("NFSHomeDirectory:"))
          home = line.replace(/^NFSHomeDirectory:\s*/, "").trim();
        if (line.startsWith("UserShell:"))
          shell = line.replace(/^UserShell:\s*/, "").trim();
      }
      return { name: normalizedName, home, shell };
    } catch {}
    return null;
  }

  try {
    const raw = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const [user = "", , , , , home = "", shell = ""] = line.split(":");
      if (user !== normalizedName) continue;
      return { name: user, home, shell };
    }
  } catch {}
  return null;
}

export function homeForUser(targetUser: string) {
  const normalizedTargetUser = normalizeUserName(targetUser);
  const target = readPasswdUser(normalizedTargetUser);
  return target?.home || defaultHomeForUser(normalizedTargetUser);
}

export function socketPathForUser(targetUser: string) {
  const normalizedTargetUser = normalizeUserName(targetUser);
  const currentUser = normalizeUserName(os.userInfo().username);
  if (!normalizedTargetUser || normalizedTargetUser === currentUser) {
    return defaultDaemonSocketPath();
  }
  if (process.platform === "darwin") {
    return path.join(
      homeForUser(normalizedTargetUser),
      "Library",
      "Caches",
      "rin-daemon",
      "daemon.sock",
    );
  }
  const uid = readUnixUserId(normalizedTargetUser);
  if (uid >= 0) {
    return path.join("/run/user", String(uid), "rin-daemon", "daemon.sock");
  }
  return defaultDaemonSocketPath();
}

export function targetUserRuntimeEnv(
  targetUser: string,
  env: Record<string, string> = {},
) {
  const uid = readUnixUserId(targetUser);
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : "";
  const busPath = runtimeDir ? path.join(runtimeDir, "bus") : "";
  return {
    ...env,
    ...(runtimeDir && fs.existsSync(runtimeDir)
      ? { XDG_RUNTIME_DIR: runtimeDir }
      : {}),
    ...(busPath && fs.existsSync(busPath)
      ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` }
      : {}),
  };
}

export function isTmuxNoServerError(exitCode: number, stderr: string) {
  if (exitCode === 0) return false;
  const text = String(stderr || "").trim();
  if (!text) return false;
  return [
    /^error connecting to .+ \((No such file or directory|Connection refused)\)$/m,
    /^no server running on /m,
  ].some((pattern) => pattern.test(text));
}

export function buildUserShell(
  targetUser: string,
  argv: string[],
  env: Record<string, string> = {},
) {
  const normalizedTargetUser = normalizeUserName(targetUser);
  const currentUser = normalizeUserName(os.userInfo().username);
  if (!normalizedTargetUser || normalizedTargetUser === currentUser) {
    return {
      command: argv[0],
      args: argv.slice(1),
      env: { ...process.env, ...env },
    };
  }

  const target = readPasswdUser(normalizedTargetUser);
  if (!target) throw new Error(`target_user_not_found:${normalizedTargetUser}`);

  const targetHome = target.home || defaultHomeForUser(normalizedTargetUser);
  const mergedEnv = { ...process.env, HOME: targetHome, ...env };
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);

  const isRoot =
    typeof process.getuid === "function" ? process.getuid() === 0 : false;
  if (
    isRoot &&
    process.platform !== "win32" &&
    fs.existsSync("/usr/sbin/runuser")
  ) {
    return {
      command: "/usr/sbin/runuser",
      args: ["-u", normalizedTargetUser, "--", "env", ...envArgs, ...argv],
      env: mergedEnv,
    };
  }

  const privilegeCommand = pickPrivilegeCommand();
  if (privilegeCommand.endsWith("doas") || privilegeCommand.endsWith("sudo")) {
    return {
      command: privilegeCommand,
      args: ["-u", normalizedTargetUser, "env", ...envArgs, ...argv],
      env: mergedEnv,
    };
  }

  const shellCommand = [
    ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...argv.map((arg) => shellQuote(arg)),
  ].join(" ");
  return {
    command: privilegeCommand,
    args: ["sh", "-lc", shellCommand],
    env: mergedEnv,
  };
}
