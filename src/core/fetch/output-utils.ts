import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function getFetchTempRootCandidates() {
  return Array.from(
    new Set(
      [process.env.RIN_TMP_DIR, "/home/rin/tmp", process.env.TMPDIR, tmpdir()]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

export async function writeFetchFullOutput(text: string) {
  for (const root of getFetchTempRootCandidates()) {
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
