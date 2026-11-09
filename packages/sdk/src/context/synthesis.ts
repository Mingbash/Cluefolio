import type { ModelRunner } from "../model.ts";
import { obj } from "../model.ts";
import type { ContextPackage, ContextStatement } from "./schema.ts";
import { TokenBudget } from "./budget.ts";
import path from "node:path";
import { hash, json } from "../util.ts";
import { validateModelOutput } from "../model.ts";

const str = { type: "string" };
const arr = (items: any) => ({ type: "array", items });
const statement = obj({ id: str, title: str, statement: str, scope: arr(str), conditions: arr(str), exceptions: arr(str), claimIds: arr(str), conflicts: arr(str) });
export const contextSynthesisSchema = obj({ description: str, theses: arr(statement), axioms: arr(statement), boundaries: arr(str) });

export async function synthesizeContext(model: ModelRunner, pkg: ContextPackage, workDir: string, budget = new TokenBudget(), signal?: AbortSignal) {
  const input = pkg.claims.map((claim) => ({
    id: claim.id, text: claim.text, originality: claim.originality,
    sourceCoverage: claim.sourceCoverage, creatorContribution: claim.creatorContribution,
    contribution: pkg.contributions.find((x) => x.claimId === claim.id)?.description ?? "",
    tags: claim.tags,
  }));
  const label = `context-synthesis-${hash(JSON.stringify(input)).slice(0, 12)}`;
  let result = await json<any>(path.join(workDir, label + ".response.json"));
  const cached = Boolean(result);
  if (result) validateModelOutput(contextSynthesisSchema, result);
  else result = await model.call<any>(
    workDir, label,
    `根据已归因的 Claim 生成 Core Thesis 与 Public Axioms。不要把单篇总结当 Thesis；只保留跨材料稳定、能指导判断和行动的主张。每条必须引用输入中的真实 claimId，必须写适用范围、条件、例外和冲突。derivative Claim 可作为上游事实，但应优先表达 creator contribution；unresolved 不得提升为确定事实。Thesis 3至8条，Axiom 5至15条。\n用途：${pkg.manifest.purpose}\n输入：${JSON.stringify(input)}`,
    contextSynthesisSchema,
    signal,
  );
  budget.consume("synthesize", cached ? Math.ceil(JSON.stringify(input).length / 3) : (model.lastInputTokens || Math.ceil(JSON.stringify(input).length / 3)));
  const known = new Set(pkg.claims.map((x) => x.id));
  const convert = (x: ContextStatement, kind: "thesis" | "axiom") => ({ ...x, version: 1 as const, kind, claimIds: x.claimIds.filter((id) => known.has(id)) });
  pkg.theses = result.theses.map((x: ContextStatement) => convert(x, "thesis")).filter((x: any) => x.claimIds.length);
  pkg.axioms = result.axioms.map((x: ContextStatement) => convert(x, "axiom")).filter((x: any) => x.claimIds.length);
  pkg.manifest.description = result.description;
  pkg.manifest.tokenBudget.used = budget.used();
  pkg.manifest.counts.theses = pkg.theses.length;
  pkg.manifest.counts.axioms = pkg.axioms.length;
  return { pkg, budget, boundaries: result.boundaries as string[] };
}
