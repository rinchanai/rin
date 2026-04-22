import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { preferredTempRootCandidates } from "../platform/fs.js";

export async function writeFetchFullOutput(text: string) {
  for (const root of preferredTempRootCandidates()) {
    try {
      await mkdir(root, { recursive: true });
      const dir = await mkdtemp(path.join(root, "rin-fetch-"));
      const filePath = path.join(dir, "fetch.txt");
      await writeFile(filePath, `${text}\n`, "utf8");
      return filePath;
    } catch {}
  }
  throw new Error("fetch_full_output_write_failed");
}
