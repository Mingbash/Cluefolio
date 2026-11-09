import path from "node:path";
import { atomic, hash, json, TaskError } from "../util.ts";
import { obj, validateModelOutput } from "../model.ts";
import type { ModelRunner } from "../model.ts";
import type { Claim, ContextPackage, CreatorContribution, EvidenceUnit, ProvenanceEdge, SourceDocument } from "./schema.ts";
import { classifyOriginality, dedupeSourceFamilies, isUpstreamOrigin } from "./attribution.ts";
import { TokenBudget } from "./budget.ts";

const str = { type: "string" };
const num = { type: "number", minimum: 0, maximum: 1 };
const bool = { type: "boolean" };
const arr = (items: any) => ({ type: "array", items });
const sourceSchema = obj({
  key: str, title: str, url: str, author: str, publisher: str, publishedAt: str,
  accessType: { type: "string", enum: ["public", "paywalled", "private", "deleted", "unknown"] },
  sourceFamily: str, contentStatus: { type: "string", enum: ["full", "partial", "metadata-only"] },
  excerpt: str,
});
const matchSchema = obj({ sourceKey: str, relation: { type: "string", enum: ["quotes", "paraphrases", "translates", "summarizes", "applies", "extends", "critiques", "curates", "supports"] }, coverage: num, confidence: num, explanation: str });
const assessmentSchema = obj({
  claimId: str,
  matches: arr(matchSchema),
  boundedSearchComplete: bool,
  crediblePriorMatch: bool,
  explicitSourceInaccessible: bool,
  unresolvedHighSimilarity: bool,
  creatorContributionType: { type: "string", enum: ["new-conclusion", "explanation", "application", "critique", "case", "reorganization", "selection", "translation-only"] },
  creatorContributionDescription: str,
  creatorContributionScore: num,
});
export const provenanceBatchSchema = obj({ sources: arr(sourceSchema), assessments: arr(assessmentSchema) });

function documentId(url: string) { return `source-${hash(url).slice(0, 20)}`; }
function evidenceId(documentId: string, excerpt: string) { return `${documentId}-e-${hash(excerpt).slice(0, 12)}`; }
export function canonicalSourceUrl(input: string) {
  const url = new URL(input);
  url.hash = "";
  if (/filter_by%3d|bing\.com/i.test(url.search)) url.search = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_.+|q|filter_by|ref|source|campaign|xsec_token|xsec_source|token|api_key)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

export async function reconstructProvenance(
  model: ModelRunner,
  pkg: ContextPackage,
  workDir: string,
  budget = new TokenBudget(),
  signal?: AbortSignal,
  onCheckpoint?: (pkg: ContextPackage, batch: number) => Promise<void>,
) {
  const evidenceById = new Map(pkg.evidenceUnits.map((x) => [x.id, x]));
  const documents = new Map(pkg.documents.map((x) => [x.id, x]));
  const edges: ProvenanceEdge[] = [...pkg.provenanceEdges];
  const contributions: CreatorContribution[] = [...pkg.contributions];
  const batchSize = budget.degraded() ? 16 : 10;
  let projectedNextCall = 0;
  const processedClaimIds = new Set<string>();
  const candidates = pkg.claims.filter((claim) => claim.originalityBasis === "legacy_candidate_not_source_traced");
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    signal?.throwIfAborted();
    if (budget.degraded() || (projectedNextCall > 0 && budget.remaining() < projectedNextCall)) break;
    const claims = candidates.slice(offset, offset + batchSize);
    const input = claims.map((claim) => ({
      id: claim.id,
      claim: claim.text,
      tags: claim.tags,
      creatorEvidence: claim.evidenceIds.slice(0, 4).map((id) => {
        const e = evidenceById.get(id);
        return e ? { id, text: e.text.slice(0, 900), locator: e.locator } : null;
      }).filter(Boolean),
    }));
    const label = `provenance-${hash(claims.map((claim) => claim.id).join(":" )).slice(0, 12)}`;
    const validateBatch = (value: any) => {
      const expected = new Set(claims.map(claim => claim.id));
      if (value.assessments.length !== expected.size ||
          value.assessments.some((assessment: any) => !expected.delete(assessment.claimId)))
        throw new TaskError("MODEL_OUTPUT", "查源结果必须恰好覆盖每个输入 Claim 一次");
    };
    const cached = await json<any>(path.join(workDir, label + ".response.json"));
    let result: any;
    let used = 0;
    if (cached) {
      validateModelOutput(provenanceBatchSchema, cached);
      result = cached;
      used = (await json<any>(path.join(workDir, label + ".usage.json")))?.inputTokens ?? 0;
    } else {
      result = await model.research<any>(
      workDir, label,
      `对以下创作者 Claim 执行有界自动查源。目标是识别很容易找到的上游原始文章、论文、报告、原视频或第一方数据，并区分“事实有来源”与“创作者提出新结论”。不要因为 Claim 引用事实，就把基于事实形成的新结论判成纯搬运。\n\n规则：\n1. 每个 Claim 最多返回3个真正相关来源，优先原始或权威来源，最多递归3层。\n2. 同一原作的翻译、转载、摘要使用相同 sourceFamily。\n3. excerpt 最多20个词；无法读取正文时 excerpt 必须为空、contentStatus=metadata-only。\n4. 完成规定查询且没有可信更早来源时，boundedSearchComplete=true、crediblePriorMatch=false。\n5. creatorContributionScore 独立于 source coverage，明确记录解释、应用、批评、案例、重组或选择价值。\n6. explicitSourceInaccessible 只在笔记明确引用了一个可识别的外部标题、链接或作品，但其正文无法读取时为 true；泛称“红杉、真格等机构”或输入小红书笔记自身不可当作该例外。\n7. 不要把输入的小红书笔记自身作为上游来源。\n8. assessments 必须覆盖每个输入 Claim，claimId 必须原样返回。为控制预算，整批最多执行2组搜索、打开最多8个页面。
9. 引用、翻译或总结必须能从可读正文定位到相同表述或同一具体框架。通用建议、单个术语或同主题文章只可标 supports。找不到证据时不要把相近观点当成原作。\n\n输入：${JSON.stringify(input)}`,
      provenanceBatchSchema,
      signal,
      validateBatch,
    );
      used = model.lastInputTokens;
      await atomic(path.join(workDir, label + ".usage.json"), { inputTokens: used });
    }
    budget.consume("discover", used);
    projectedNextCall = used;
    const batchSources = new Map<string, SourceDocument>();
    for (const source of result.sources) {
      let url: URL;
      try { url = new URL(canonicalSourceUrl(source.url)); if (!/^https?:$/.test(url.protocol)) continue; } catch { continue; }
      const existing = [...documents.values()].find((item) => item.canonicalUrl === url.href || item.url === url.href);
      if (existing) {
        batchSources.set(source.key, existing);
        continue;
      }
      const id = documentId(url.href);
      const contentStatus = source.accessType === "public" && source.excerpt.trim()
        ? source.contentStatus : "metadata-only";
      const document: SourceDocument = {
        version: 1, id, kind: source.accessType === "public" ? "article" : "restricted",
        title: source.title, url: url.href, canonicalUrl: url.href, author: source.author || null,
        publisher: source.publisher || null, publishedAt: source.publishedAt || null,
        sourceFamily: source.sourceFamily || id, accessType: source.accessType,
        rightsScope: "link-only", contentStatus,
      };
      documents.set(id, document);
      batchSources.set(source.key, document);
      if (contentStatus !== "metadata-only") {
        const idEvidence = evidenceId(id, source.excerpt);
        if (!evidenceById.has(idEvidence)) evidenceById.set(idEvidence, {
          version: 1, id: idEvidence, documentId: id, kind: "source-text", text: source.excerpt.trim(),
          locator: { kind: "url", url: url.href }, verified: true, confidence: null,
          language: "und", sourceHash: hash(source.excerpt.trim()),
        });
      }
    }
    for (const assessment of result.assessments) {
      const claim = pkg.claims.find((x) => x.id === assessment.claimId);
      if (!claim) continue;
      processedClaimIds.add(claim.id);
      const localEdges: ProvenanceEdge[] = [];
      for (const match of assessment.matches) {
        const source = batchSources.get(match.sourceKey);
        if (!source || (source.noteId && source.noteId === claim.noteId)) continue;
        const sourceEvidence = [...evidenceById.values()].filter((x) => x.documentId === source.id).map((x) => x.id);
        localEdges.push({ version: 1, id: `edge-${hash(`${claim.id}:${source.id}:${match.relation}`).slice(0, 20)}`, fromClaimId: claim.id, toSourceId: source.id, relation: match.relation, coverage: match.coverage, confidence: match.confidence, evidenceIds: sourceEvidence, sourceFamily: source.sourceFamily, depth: 1, verified: source.accessType === "public" && sourceEvidence.length > 0 });
      }
      const distinct = dedupeSourceFamilies(localEdges);
      edges.push(...distinct);
      claim.sourceCoverage = distinct.reduce((max, edge) => Math.max(max, edge.coverage * edge.confidence), 0);
      claim.creatorContribution = assessment.creatorContributionScore;
      const texts = (ids: string[]) => ids.map(id => evidenceById.get(id)?.text ?? "");
      const origins = distinct.filter(edge => isUpstreamOrigin(edge, texts(edge.evidenceIds), texts(claim.evidenceIds)));
      const classified = classifyOriginality({
        sourceCoverage: claim.sourceCoverage,
        creatorContribution: claim.creatorContribution,
        boundedSearchComplete: assessment.boundedSearchComplete,
        crediblePriorMatch: assessment.crediblePriorMatch && origins.length > 0,
        explicitSourceInaccessible:
          assessment.explicitSourceInaccessible &&
          assessment.matches.some((match: any) => {
            const source = batchSources.get(match.sourceKey);
            return source && !source.noteId && source.accessType !== "public";
          }),
        unresolvedHighSimilarity: assessment.unresolvedHighSimilarity,
      });
      claim.originality = classified.originality;
      claim.originalityBasis = classified.basis;
      if (assessment.creatorContributionDescription.trim()) {
        const id = `contribution-${claim.id}`;
        const existingContribution = contributions.findIndex((item) => item.id === id);
        if (existingContribution >= 0) contributions.splice(existingContribution, 1);
        contributions.push({
        version: 1, id, claimId: claim.id,
        type: assessment.creatorContributionType,
        description: assessment.creatorContributionDescription,
        creatorEvidenceIds: claim.evidenceIds,
        upstreamClaimIds: [], score: assessment.creatorContributionScore,
      });
      }
    }
    pkg.documents = [...documents.values()];
    pkg.evidenceUnits = [...evidenceById.values()];
    pkg.provenanceEdges = dedupeSourceFamilies(edges);
    pkg.contributions = contributions;
    pkg.manifest.tokenBudget.used = budget.used();
    pkg.manifest.counts = { ...pkg.manifest.counts, documents: pkg.documents.length, evidenceUnits: pkg.evidenceUnits.length, provenanceEdges: pkg.provenanceEdges.length, contributions: pkg.contributions.length };
    await onCheckpoint?.(pkg, offset / batchSize + 1);
  }
  pkg.documents = [...documents.values()];
  pkg.evidenceUnits = [...evidenceById.values()];
  pkg.provenanceEdges = dedupeSourceFamilies(edges);
  pkg.contributions = contributions;
  pkg.manifest.tokenBudget.used = budget.used();
  pkg.manifest.counts = { ...pkg.manifest.counts, documents: pkg.documents.length, evidenceUnits: pkg.evidenceUnits.length, provenanceEdges: pkg.provenanceEdges.length, contributions: pkg.contributions.length };
  return {
    pkg,
    budget,
    processedClaimIds: [...processedClaimIds],
    traceAttemptedClaims: pkg.claims.filter((claim) => claim.originalityBasis !== "legacy_candidate_not_source_traced").length,
    complete: pkg.claims.every((claim) => claim.originalityBasis !== "legacy_candidate_not_source_traced"),
  };
}
