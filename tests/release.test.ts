import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { unzipSync } from "fflate";
import { createSourceArchive } from "../scripts/release-archive.ts";
import { hash, run } from "../packages/sdk/src/util.ts";

test("public candidate matches sources, excludes private data and preserves Mac executable mode", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "shizhi-release-test-"),
  );
  try {
    const output = path.join(temporary, "candidate.zip");
    const result = await createSourceArchive(output);
    const bytes = await readFile(output);
    assert.equal(hash(bytes), result.sha256);
    assert.match(
      await readFile(output + ".sha256", "utf8"),
      new RegExp(`^${result.sha256}  candidate.zip`),
    );
    const files = unzipSync(bytes);
    const prefix = "Cluefolio/";
    const manifest = JSON.parse(
      Buffer.from(files[prefix + "SOURCE-MANIFEST.json"]).toString(),
    );
    assert.equal(Object.keys(files).length, manifest.files.length + 1);
    for (const file of manifest.files) {
      assert.equal(hash(Buffer.from(files[prefix + file.path])), file.sha256);
      assert.equal(hash(await readFile(file.path)), file.sha256, file.path);
      assert.doesNotMatch(
        file.path,
        /(^|\/)(data|node_modules|dist|\.git|\.env|tools)(\/|$)|^VALIDATION\.md$/,
      );
    }
    for (const file of [
      "apps/web/src/main.tsx",
      "apps/web/src/style.css",
      "apps/web/src/copy.ts",
      "apps/web/src/attribution.tsx",
      "apps/desktop/note-picker.html",
      ".github/workflows/ci.yml",
      "docs/release-readiness.md",
    ])
      assert.ok(files[prefix + file], file);
    let foundLauncher = false;
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
      const nameLength = bytes.readUInt16LE(i + 28);
      const name = bytes.subarray(i + 46, i + 46 + nameLength).toString();
      if (name !== prefix + "启动Cluefolio.command") continue;
      assert.equal(bytes[i + 5], 3, "Unix ZIP metadata");
      assert.equal((bytes.readUInt32LE(i + 38) >>> 16) & 0o777, 0o755);
      foundLauncher = true;
    }
    assert.ok(foundLauncher);
    assert.equal(
      (await createSourceArchive(path.join(temporary, "second.zip"))).sha256,
      result.sha256,
    );

    // Verify the scanner fails closed on a credential introduced into an otherwise valid snapshot.
    const source = path.join(temporary, "source");
    for (const file of manifest.files) {
      const destination = path.join(source, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, files[prefix + file.path]);
    }
    await writeFile(
      path.join(source, "apps/leaked.json"),
      JSON.stringify({ access: "gh" + "p_" + "a".repeat(30) }),
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.resolve("scripts/release-source.ts"),
          path.join(temporary, "rejected"),
        ],
        { cwd: source },
      ),
      /apps\/leaked.json/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
