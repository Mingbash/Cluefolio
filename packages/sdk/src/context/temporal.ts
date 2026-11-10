import type { Claim, ContextPackage, ContextStatement } from "./schema.ts";

const volatile = /价格|收费|套餐|平台规则|政策|法规|合规|市场规模|市占率|用户数|增长率|当前|现在|今年|最新|估值|利率|费率|[12][09]\d{2}年|\b(?:20\d{2}|today|current|latest|pricing|policy|market size)\b/i;

export function annotateTemporality(pkg: ContextPackage) {
  const documents = new Map(pkg.documents.map(doc => [doc.id, doc]));
  for (const claim of pkg.claims) {
    if (claim.temporal) continue;
    const dates = claim.evidenceIds.map(id => pkg.evidenceUnits.find(unit => unit.id === id))
      .map(unit => documents.get(unit?.documentId ?? "")?.publishedAt)
      .filter((date): date is string => !!date);
    const sourceDate = dates.sort().at(-1) ?? null;
    const sensitivity = volatile.test(claim.text) ? "time-sensitive" : claim.type === "framework" ? "durable-principle" : "unknown";
    claim.temporal = { sensitivity, sourceDate, reason: sensitivity === "time-sensitive" ? "涉及可能变化的数字、规则或具体做法" : sensitivity === "durable-principle" ? "方法框架，仍须检查适用条件" : "材料未足以判定时效" };
  }
  for (const statement of [...pkg.theses, ...pkg.axioms] as ContextStatement[]) {
    if (statement.temporal) continue;
    const support = statement.claimIds.map(id => pkg.claims.find(claim => claim.id === id)).filter((claim): claim is Claim => !!claim);
    const sensitivity = volatile.test(statement.statement) || support.some(claim => claim.temporal?.sensitivity === "time-sensitive")
      ? "time-sensitive" : "durable-principle";
    const sourceDate = support.map(claim => claim.temporal?.sourceDate).filter((date): date is string => !!date).sort().at(-1) ?? null;
    statement.temporal = { sensitivity, sourceDate, reason: sensitivity === "time-sensitive" ? "包含可能变化的具体事实或建议" : "提炼为原则，使用时仍须核对条件" };
  }
  return pkg;
}
