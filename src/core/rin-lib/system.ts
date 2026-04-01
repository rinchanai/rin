import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { defaultDaemonSocketPath } from "./common.js";

export function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
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
  if (process.platform === "darwin") {
    try {
      const detail = execFileSync(
        "dscl",
        [".", "-read", `/Users/${name}`, "NFSHomeDirectory", "UserShell"],
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
      return { name, home, shell };
    } catch {}
    return null;
  }

  try {
    const raw = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const [user = "", , , , , home = "", shell = ""] = line.split(":");
      if (user !== name) continue;
      return { name: user, home, shell };
    }
  } catch {}
  return null;
}

export function homeForUser(targetUser: string) {
  const target = readPasswdUser(targetUser);
  return (
    target?.home ||
    path.join(process.platform === "darwin" ? "/Users" : "/home", targetUser)
  );
}

export function socketPathForUser(targetUser: string) {
  const currentUser = os.userInfo().username;
  if (!targetUser || targetUser === currentUser)
    return defaultDaemonSocketPath();
  if (process.platform === "darwin")
    return path.join(
      homeForUser(targetUser),
      "Library",
      "Caches",
      "rin-daemon",
      "daemon.sock",
    );
  const uid = Number(
    execFileSync("id", ["-u", targetUser], { encoding: "utf8" }).trim() || "-1",
  );
  if (uid >= 0)
    return path.join("/run/user", String(uid), "rin-daemon", "daemon.sock");
  return defaultDaemonSocketPath();
}

export function targetUserRuntimeEnv(
  targetUser: string,
  env: Record<string, string> = {},
) {
  const target = readPasswdUser(targetUser);
  const uid =
    typeof process.platform === "string" &&
    process.platform !== "darwin" &&
    target?.name
      ? Number(
          execFileSync("id", ["-u", targetUser], { encoding: "utf8" }).trim() ||
            "-1",
        )
      : -1;
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
  const currentUser = os.userInfo().username;
  if (!targetUser || targetUser === currentUser) {
    return {
      command: argv[0],
      args: argv.slice(1),
      env: { ...process.env, ...env },
    };
  }

  const target = readPasswdUser(targetUser);
  if (!target) throw new Error(`target_user_not_found:${targetUser}`);

  const targetHome =
    target.home ||
    `${process.platform === "darwin" ? "/Users" : "/home"}/${targetUser}`;
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
      args: ["-u", targetUser, "--", "env", ...envArgs, ...argv],
      env: mergedEnv,
    };
  }

  const privilegeCommand = pickPrivilegeCommand();
  if (privilegeCommand.endsWith("doas") || privilegeCommand.endsWith("sudo")) {
    return {
      command: privilegeCommand,
      args: ["-u", targetUser, "env", ...envArgs, ...argv],
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
