import path from "node:path";

export function dataRootForState(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), "data", "web-search");
}
