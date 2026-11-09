import path from "node:path";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { atomic, hashFile } from "../util.ts";
import type { ContextPackage } from "./schema.ts";
import { validateContextPackage } from "./schema.ts";

function jsonl(values: unknown[]) { return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""); }

async function walk(dir: string, base = dir): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full, base));
    else result.push(path.relative(base, full));
  }
  return result.sort();
}

export async function writeContextPackage(pkg: ContextPackage, directory: string) {
  validateContextPackage(pkg);
  await rm(directory, { recursive: true, force: true });
  for (const name of ["sources", "evidence", "claims", "provenance", "context", "evaluation", "indexes"]) await mkdir(path.join(directory, name), { recursive: true });
  await atomic(path.join(directory, "sources", "documents.jsonl"), jsonl(pkg.documents));
  await atomic(path.join(directory, "evidence", "units.jsonl"), jsonl(pkg.evidenceUnits));
  await atomic(path.join(directory, "claims", "claims.jsonl"), jsonl(pkg.claims));
  await atomic(path.join(directory, "provenance", "edges.jsonl"), jsonl(pkg.provenanceEdges));
  await atomic(path.join(directory, "provenance", "creator-contributions.jsonl"), jsonl(pkg.contributions));
  await atomic(path.join(directory, "context", "theses.json"), pkg.theses);
  await atomic(path.join(directory, "context", "axioms.json"), pkg.axioms);
  await atomic(path.join(directory, "context", "overview.md"), `# ${pkg.manifest.name}\n\n${pkg.manifest.description}\n\n状态：${pkg.manifest.status}\n\n材料：${pkg.documents.length}；证据单元：${pkg.evidenceUnits.length}；候选观点：${pkg.claims.length}。\n`);
  const hashes: Record<string, string> = {};
  for (const file of await walk(directory)) if (file !== "manifest.json") hashes[file] = await hashFile(path.join(directory, file));
  pkg.manifest.hashes = hashes;
  pkg.manifest.updatedAt = new Date().toISOString();
  await atomic(path.join(directory, "manifest.json"), pkg.manifest);
  return { directory, manifest: pkg.manifest };
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

export async function verifyContextDirectory(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const failures: string[] = [];
  for (const [file, expected] of Object.entries(manifest.hashes as Record<string, string>)) {
    try { if (await hashFile(path.join(directory, file)) !== expected) failures.push(file); }
    catch { failures.push(file); }
  }
  return { valid: failures.length === 0, failures, manifest };
}
