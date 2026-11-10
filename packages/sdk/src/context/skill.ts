import os from "node:os";
import path from "node:path";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ContextManifest } from "./schema.ts";
import { TaskError, safeName } from "../util.ts";

/** The installed Skill is a route to the package, never a copy of its corpus. */
export async function installContextSkill(manifest: ContextManifest, packageDir: string) {
  const name = manifest.contextId;
  safeName(name);
  const source = path.join(packageDir, "skill", name);
  const dest = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", name);
  const marker = { contextId: name, version: manifest.version, managedBy: "cluefolio" };
  let customSource: string | undefined;
  try {
    const existing = await readFile(path.join(source, "SKILL.md"), "utf8");
    if (!existing.includes("此 Skill 只指向 Context Package") && existing.includes(name) && existing.includes("cluefolio-desktop"))
      customSource = existing;
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.join(source, "agents"), { recursive: true });
  const description = `调用本机 Cluefolio Context ${name} 回答问题，引用可核对的来源。${manifest.status === "draft" ? "当前是部分材料草稿。" : ""}`;
  const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${manifest.name} · Context 调用入口${manifest.status === "draft" ? "（草稿）" : ""}\n\n此 Skill 只指向 Context Package。正文、来源关系和媒体定位存放在本机 Context 中。\n\n1. 调用 \`cluefolio-desktop.get_overview\`，使用 \`contextId: ${name}\`、\`version: ${manifest.version}\` 查看状态与原则。\n2. 按用户问题调用 \`cluefolio-desktop.build_context_packet\`；需要时调用 \`search\`、\`trace_claim\`、\`read_evidence\`。\n3. 区分上游事实、创作者贡献与当前推导，附原文、图片页或视频时间码。\n4. 对价格、规则、市场数据和具体操作建议，先看来源日期，再核查当前一手来源后给执行建议。日期缺失时说“日期未确认”。\n5. Context 为草稿时说明已处理与未处理材料，不把缺失部分写成已验证结论。\n`;
  await writeFile(path.join(source, "SKILL.md"), customSource ?? skill);
  await writeFile(path.join(source, "cluefolio.json"), JSON.stringify(marker, null, 2));
  const agentFile = path.join(source, "agents", "openai.yaml");
  if (!customSource) await writeFile(agentFile, `interface:\n  display_name: ${JSON.stringify(manifest.name)}\n  short_description: ${JSON.stringify("用 Context 证据回答并推荐原文")}\n  default_prompt: ${JSON.stringify(`使用 $${name} 回答我的问题，并附可回看的来源。`)}\n`);
  await mkdir(path.dirname(dest), { recursive: true });
  let preservedLegacy: string | undefined;
  try {
    const existing = JSON.parse(await readFile(path.join(dest, "cluefolio.json"), "utf8"));
    if (existing.managedBy !== "cluefolio" || existing.contextId !== name)
      throw new TaskError("EXISTS", `同名 Skill ${name} 已存在`);
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new TaskError("EXISTS", `同名 Skill ${name} 已存在`);
      throw error;
    }
    try {
      const legacy = await readFile(path.join(dest, "SKILL.md"), "utf8");
      if (!legacy.includes("cluefolio-desktop") || !legacy.includes(`contextId`) || !legacy.includes(name))
        throw new TaskError("EXISTS", `同名 Skill ${name} 已存在`);
      preservedLegacy = legacy;
    } catch (nested: any) { if (nested.code !== "ENOENT") throw nested; }
  }
  if (preservedLegacy) {
    await writeFile(path.join(source, "SKILL.md"), preservedLegacy);
    try { await cp(path.join(dest, "agents", "openai.yaml"), path.join(source, "agents", "openai.yaml"), { force: true }); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  const tmp = `${dest}.cluefolio-${randomUUID()}`;
  await cp(source, tmp, { recursive: true });
  const backup = `${dest}.previous-${randomUUID()}`;
  let hadOld = false;
  try {
    try { await rename(dest, backup); hadOld = true; } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    await rename(tmp, dest);
    if (hadOld) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadOld) await rename(backup, dest).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
  return { name, path: dest, source };
}
