import {
  mkdtemp,
  readdir,
  readFile,
  stat,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8, type Zippable } from "fflate";
import { hash, run } from "../packages/sdk/src/util.ts";

/** Package only the audited public snapshot, never the working tree or its history. */
export async function createSourceArchive(output: string) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cluefolio-release-"));
  const entries: Zippable = {};
  const manifest: { path: string; sha256: string; mode: number }[] = [];
  const prefix = "Cluefolio/";
  // Fixed ZIP timestamp makes identical public sources produce identical archives.
  const mtime = new Date(2026, 0, 1);
  try {
    const source = path.join(temporary, "source");
    await run(process.execPath, [
      "--import",
      "tsx",
      "scripts/release-source.ts",
      source,
    ]);
    async function walk(dir: string, relative = "") {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )) {
        const file = path.join(dir, entry.name);
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(file, name);
        else if (entry.isFile()) {
          const bytes = await readFile(file);
          const mode = (await stat(file)).mode & 0o111 ? 0o100755 : 0o100644;
          entries[prefix + name] = [bytes, { os: 3, attrs: mode << 16, mtime }];
          manifest.push({ path: name, sha256: hash(bytes), mode });
        }
      }
    }
    await walk(source);
    entries[prefix + "SOURCE-MANIFEST.json"] = [
      strToU8(
        JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2) + "\n",
      ),
      { os: 3, attrs: 0o100644 << 16, mtime },
    ];
    const bytes = zipSync(entries, { level: 6 });
    const sha256 = hash(Buffer.from(bytes));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
    await writeFile(
      output + ".sha256",
      `${sha256}  ${path.basename(output)}\n`,
    );
    return {
      file: output,
      files: manifest.length,
      bytes: bytes.length,
      sha256,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  console.log(
    JSON.stringify(
      await createSourceArchive(
        process.argv[2] ?? "dist/cluefolio-v0.2.0-rc1-source.zip",
      ),
      null,
      2,
    ),
  );
