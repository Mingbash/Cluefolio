import path from "node:path";
import os from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { run } from "../packages/sdk/src/util.ts";

type Entry = { name: string; transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> } };
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const cli = process.env.CODEX_BIN || "codex";
const desired = "cluefolio-desktop";
const desktopPath = path.join(root, "scripts", "desktop-mcp.mjs");

export async function migrateLocalRegistration() {
  const entries = JSON.parse(await run(cli, ["mcp", "list", "--json"], { timeout: 15_000 })) as Entry[];
  const sameProject = entries.filter(entry => entry.transport?.type === "stdio" &&
    entry.transport.args?.some(arg => arg === desktopPath || arg === path.join(root, "scripts", "context-mcp.ts") || arg === path.join(root, "tools", "desktop-mcp-probe", "server.mjs")));
  const active = sameProject.find(entry => entry.name === desired && entry.transport?.args?.includes(desktopPath));
  if (!active) {
    const existingName = entries.find(entry => entry.name === desired);
    if (existingName) throw new Error("cluefolio-desktop 已由另一项目占用，请先检查本机 MCP 配置");
    const previous = sameProject.find(entry => entry.transport?.args?.includes(desktopPath));
    const args = ["mcp", "add", desired];
    for (const [key, value] of Object.entries(previous?.transport?.env ?? {}))
      if (key === "OPENCLI_BIN" || key === "XHS_DATA_DIR") args.push("--env", `${key}=${value}`);
    args.push("--", previous?.transport?.command || process.execPath, desktopPath);
    await run(cli, args, { timeout: 15_000 });
  }
  const after = JSON.parse(await run(cli, ["mcp", "list", "--json"], { timeout: 15_000 })) as Entry[];
  if (!after.some(entry => entry.name === desired && entry.transport?.args?.includes(desktopPath)))
    throw new Error("新 MCP 连接未注册成功，旧连接已保留");
  for (const entry of sameProject.filter(entry => entry.name !== desired)) {
    await run(cli, ["mcp", "remove", entry.name], { timeout: 15_000 });
  }
  const skillRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "dujiangang_invest");
  for (const file of [path.join(skillRoot, "SKILL.md"), path.join(skillRoot, "agents", "openai.yaml")]) {
    try {
      let content = await readFile(file, "utf8");
      if (!content.includes("dujiangang_invest")) continue;
      for (const entry of sameProject) if (entry.name !== desired) content = content.replaceAll(entry.name, desired);
      content = content.replace(/\x73\x68\x69\x7a\x68\x69|\u62fe\u77e5/gi, "Cluefolio");
      await writeFile(file, content);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return { name: desired, removed: sameProject.filter(entry => entry.name !== desired).map(entry => entry.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await migrateLocalRegistration());
}
