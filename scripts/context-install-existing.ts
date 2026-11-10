import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config, ContextRuntime, installContextSkill } from "../packages/sdk/src/index.ts";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const cfg = config(root);
const contexts = await new ContextRuntime(cfg.dataDir).listContexts();
for (const manifest of contexts) {
  const packageDir = path.join(cfg.dataDir, "contexts", manifest.contextId, manifest.version);
  for (const name of ["SKILL.md", path.join("agents", "openai.yaml")]) {
    const file = path.join(packageDir, "skill", manifest.contextId, name);
    try {
      const before = await readFile(file, "utf8");
      const after = before.replace(/\x73\x68\x69\x7a\x68\x69|\u62fe\u77e5/gi, "Cluefolio").replaceAll("cluefolio-context", "cluefolio-desktop");
      if (before !== after) await writeFile(file, after);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  await installContextSkill(manifest, packageDir);
}
console.log(`已核对 ${contexts.length} 个 Context 的调用 Skill。`);
