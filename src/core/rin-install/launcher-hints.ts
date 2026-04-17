export function buildLauncherCommand(command = "") {
  const suffix = String(command || "").trim();
  return suffix ? `rin ${suffix}` : "rin";
}
