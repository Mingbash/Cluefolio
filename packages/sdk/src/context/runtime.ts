import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Store } from "../store.ts";
import { TaskError, atomic } from "../util.ts";
import type { Claim, ContextManifest, ContextPackage, EvidenceUnit, Originality, SourceDocument } from "./schema.ts";
import { readJsonl, verifyContextDirectory, writeContextPackage } from "./package.ts";
import { isUpstreamOrigin } from "./attribution.ts";
import { makeZip } from "../export.ts";

export type SearchHit = {
  evidence: EvidenceUnit;
  document: SourceDocument;
  score: number;
  claimIds: string[];
};

function terms(query: string) {
  const normalized = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const phrases = normalized.match(/\p{Script=Han}+/gu) ?? [];
  const ngrams = phrases.flatMap(phrase => [...phrase].flatMap((_, i) =>
    [phrase.slice(i, i + 2), phrase.slice(i, i + 3)].filter((term, j) => term.length === 2 + j)));
  return [...new Set([...words, ...ngrams])].filter((x) => x.length > 1);
}

function lexicalScore(text: string, queryTerms: string[]) {
  const haystack = text.toLowerCase();
  if (!queryTerms.length) return 0;
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? Math.min(3, 1 + term.length / 4) : 0), 0) / queryTerms.length;
}

export async function loadContextPackage(directory: string): Promise<ContextPackage> {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as ContextManifest;
  return {
    manifest,
    documents: await readJsonl(path.join(directory, "sources", "documents.jsonl")),
    evidenceUnits: await readJsonl(path.join(directory, "evidence", "units.jsonl")),
    claims: await readJsonl(path.join(directory, "claims", "claims.jsonl")),
    provenanceEdges: await readJsonl(path.join(directory, "provenance", "edges.jsonl")),
    contributions: await readJsonl(path.join(directory, "provenance", "creator-contributions.jsonl")),
    theses: JSON.parse(await readFile(path.join(directory, "context", "theses.json"), "utf8")),
    axioms: JSON.parse(await readFile(path.join(directory, "context", "axioms.json"), "utf8")),
  };
}

export async function buildContextIndex(directory: string) {
  const pkg = await loadContextPackage(directory);
  const file = path.join(directory, "indexes", "index.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, locator TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL, evidence_ids TEXT NOT NULL, originality TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insertEvidence = db.prepare("INSERT INTO evidence VALUES (?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO evidence_fts(id, text) VALUES (?, ?)");
    const insertClaim = db.prepare("INSERT INTO claims VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN IMMEDIATE; DELETE FROM evidence; DELETE FROM claims; DELETE FROM evidence_fts;");
    db.prepare("INSERT OR REPLACE INTO index_state VALUES ('evidence-ngram-v1', ?)").run(pkg.manifest.hashes["evidence/units.jsonl"] ?? "");
    for (const unit of pkg.evidenceUnits) {
      insertEvidence.run(unit.id, unit.documentId, unit.kind, unit.text, JSON.stringify(unit.locator));
      insertFts.run(unit.id, terms(unit.text).join(" "));
    }
    for (const claim of pkg.claims) insertClaim.run(claim.id, claim.text, claim.tags.join(" "), JSON.stringify(claim.evidenceIds), claim.originality);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    throw error;
  } finally { db.close(); }
  return file;
}

function indexCandidates(directory: string, terms: string[], expected: string) {
  const file = path.join(directory, "indexes", "index.sqlite");
  if (!expected || !terms.length || !existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const state = db.prepare("SELECT value FROM index_state WHERE key = 'evidence-ngram-v1'").get();
      if (state?.value !== expected) return null;
      const query = terms.map(term => `"${term}"`).join(" OR ");
      const rows = db.prepare("SELECT id FROM evidence_fts WHERE evidence_fts MATCH ?").all(query);
      return new Set(rows.map(row => String(row.id)));
    } finally {
      db.close();
    }
  } catch {
    return null; // The canonical package remains readable if the derived index is damaged.
  }
}

function confirmedOrigins(pkg: ContextPackage, edges = pkg.provenanceEdges) {
  const units = new Map(pkg.evidenceUnits.map(item => [item.id, item.text]));
  const claims = new Map(pkg.claims.map(item => [item.id, item]));
  const docs = new Map(pkg.documents.map(item => [item.id, item]));
  const texts = (ids: string[]) => ids.map(id => units.get(id) ?? "");
  return new Set(edges.filter(edge => {
    const claim = claims.get(edge.fromClaimId);
    const upstream = docs.get(edge.toSourceId ?? "");
    if (!upstream || upstream.accessType !== "public") return false;
    const note = docs.get(`xhs-${claim?.noteId}`);
    const before = Date.parse(upstream.publishedAt ?? "");
    const after = Date.parse(note?.publishedAt ?? "");
    if (Number.isFinite(before) && Number.isFinite(after) && before > after) return false;
    return isUpstreamOrigin(edge, texts(edge.evidenceIds), texts(claim?.evidenceIds ?? []));
  }).map(edge => edge.id));
}

export type AttributionReview = {
  id: string;
  claimId: string;
  originality: Originality;
  excludedEdges: string[];
  reason: string;
  contribution?: string;
  claimText: string;
  reviewedAt: string;
};

export class ContextRuntime {
  constructor(readonly dataDir: string) {}
  private root(contextId: string, version = "0.1.0") {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(contextId) || !/^\d+\.\d+\.\d+$/.test(version)) throw new TaskError("CONTEXT_ID", "Context 标识或版本不合法");
    return path.join(this.dataDir, "contexts", contextId, version);
  }
  private async reviewedPackage(contextId: string, version = "0.1.0") {
    const pkg = await loadContextPackage(this.root(contextId, version));
    const store = new Store(this.dataDir);
    const reviews: AttributionReview[] = [];
    const originalEdges = pkg.provenanceEdges;
    const authorReviews: { sourceId: string; author: string; reason: string }[] = [];
    try {
      for (const claim of pkg.claims) {
        const review = store.get<AttributionReview>("attribution-review", `${contextId}/${version}/${claim.id}`);
        if (!review || claim.text !== review.claimText) continue;
        reviews.push(review);
        claim.originality = review.originality;
        claim.originalityBasis = "local_attribution_review";
        pkg.provenanceEdges = pkg.provenanceEdges.filter(edge =>
          edge.fromClaimId !== claim.id || !review.excludedEdges.includes(edge.id));
        if (review.contribution !== undefined) {
          const contribution = pkg.contributions.find(item => item.claimId === claim.id);
          if (contribution) contribution.description = review.contribution;
          else if (review.contribution) pkg.contributions.push({
            version: 1, id: `manual-${claim.id}`, claimId: claim.id, type: "explanation",
            description: review.contribution, creatorEvidenceIds: claim.evidenceIds, upstreamClaimIds: [],
            score: claim.creatorContribution,
          });
        }
        claim.sourceCoverage = Math.max(0, ...pkg.provenanceEdges.filter(edge =>
          edge.fromClaimId === claim.id).map(edge => edge.coverage * edge.confidence));
      }
      for (const source of pkg.documents) {
        const review = store.get<{ author: string; reason: string }>("source-author-review", `${contextId}/${version}/${source.id}`);
        if (!review) continue;
        source.author = review.author;
        authorReviews.push({ sourceId: source.id, author: review.author, reason: review.reason });
      }
    } finally {
      store.close();
    }
    return { pkg, reviews, originalEdges, authorReviews };
  }

  async attribution(contextId: string, version = "0.1.0") {
    const { pkg, reviews, originalEdges, authorReviews } = await this.reviewedPackage(contextId, version);
    return {
      claims: pkg.claims,
      sources: pkg.documents.map(({ id, title, kind, url, accessType, author }) => ({ id, title, kind, url, accessType, author })),
      authorReviews,
      edges: originalEdges,
      confirmedOriginIds: [...confirmedOrigins(pkg)],
      contributions: pkg.contributions,
      reviews,
    };
  }

  async reviewAttribution(contextId: string, claimId: string, version: string, input: Pick<AttributionReview, "originality" | "excludedEdges" | "reason" | "contribution"> | null) {
    const pkg = await loadContextPackage(this.root(contextId, version));
    const claim = pkg.claims.find(item => item.id === claimId);
    if (!claim) throw new TaskError("NOT_FOUND", "观点不存在");
    const id = `${contextId}/${version}/${claimId}`;
    const store = new Store(this.dataDir);
    try {
      if (input === null) {
        store.db.prepare("DELETE FROM records WHERE kind = 'attribution-review' AND id = ?").run(id);
        return { review: null };
      }
      const edges = pkg.provenanceEdges.filter(edge => edge.fromClaimId === claimId);
      if (!input.reason.trim() || input.excludedEdges.some(id => !edges.some(edge => edge.id === id)))
        throw new TaskError("REVIEW", "请填写理由，并只修正这条观点关联的来源");
      const review = { ...input, id, claimId, claimText: claim.text, reviewedAt: new Date().toISOString() };
      store.put("attribution-review", review);
      return { review };
    } finally {
      store.close();
    }
  }

  async reviewAuthor(contextId: string, sourceId: string, version: string, input: { author: string; reason: string } | null) {
    const pkg = await loadContextPackage(this.root(contextId, version));
    if (!pkg.documents.some(source => source.id === sourceId)) throw new TaskError("NOT_FOUND", "来源不存在");
    const id = `${contextId}/${version}/${sourceId}`;
    const store = new Store(this.dataDir);
    try {
      if (input === null) store.db.prepare("DELETE FROM records WHERE kind = 'source-author-review' AND id = ?").run(id);
      else {
        if (!input.author.trim() || !input.reason.trim()) throw new TaskError("REVIEW", "请填写作者和修正理由");
        const record = { id, ...input, reviewedAt: new Date().toISOString() };
        store.put("source-author-review", record);
      }
    } finally { store.close(); }
    return { ok: true };
  }

  async evaluatePackage(contextId: string, version = "0.1.0") {
    const directory = this.root(contextId, version);
    const { pkg, reviews, authorReviews } = await this.reviewedPackage(contextId, version);
    const integrity = await verifyContextDirectory(directory);
    let metrics = null;
    try {
      metrics = JSON.parse(await readFile(path.join(this.dataDir, "context-evaluations", contextId, version + ".json"), "utf8"));
    } catch { /* evaluation is separate from the package */ }
    return {
      integrity: integrity.valid,
      failures: integrity.failures,
      resolved: pkg.claims.filter(claim => claim.originality !== "unresolved").length,
      total: pkg.claims.length,
      statements: pkg.theses.length + pkg.axioms.length,
      reviews: reviews.length + authorReviews.length,
      timings: pkg.manifest.stages.filter(stage => stage.elapsedMs > 0)
        .map(({ stage, elapsedMs }) => ({ stage, elapsedMs })),
      metrics,
    };
  }

  async listContexts() {
    const root = path.join(this.dataDir, "contexts");
    if (!existsSync(root)) return [];
    const result: ContextManifest[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const contextId = entry.name;
      const contextRoot = path.join(root, contextId);
      const versions = (await readdir(contextRoot, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name).sort().reverse();
      for (const version of versions) {
        try { result.push(JSON.parse(await readFile(path.join(contextRoot, version, "manifest.json"), "utf8"))); break; } catch { /* ignore incomplete folder */ }
      }
    }
    return result;
  }
  async register(contextId: string, version = "0.1.0") {
    const manifest = JSON.parse(await readFile(path.join(this.root(contextId, version), "manifest.json"), "utf8")) as ContextManifest;
    const registryFile = path.join(this.dataDir, "contexts", "registry.json");
    let registry: any = { version: 1, contexts: {} };
    try { registry = JSON.parse(await readFile(registryFile, "utf8")); } catch { /* first registration */ }
    registry.contexts[contextId] = { version, path: `${contextId}/${version}`, name: manifest.name, updatedAt: manifest.updatedAt };
    await atomic(registryFile, registry);
    return registry.contexts[contextId];
  }
  async exportPackage(contextId: string, version = "0.1.0") {
    const source = this.root(contextId, version);
    const { pkg, reviews, authorReviews } = await this.reviewedPackage(contextId, version);
    const exports = path.join(this.dataDir, "context-exports");
    await mkdir(exports, { recursive: true });
    const target = path.join(exports, `${contextId}-${version}.zip`);
    const temporary = await mkdtemp(path.join(exports, ".export-"));
    try {
      let archiveSource = source;
      if (reviews.length || authorReviews.length) {
        archiveSource = path.join(temporary, "reviewed");
        const retainedEvidence = new Set([...pkg.provenanceEdges.flatMap(edge => edge.evidenceIds),
          ...pkg.claims.flatMap(claim => claim.evidenceIds)]);
        const removed = new Set(reviews.flatMap(review => review.excludedEdges));
        const original = await loadContextPackage(source);
        const withdrawn = new Set(original.provenanceEdges.filter(edge => removed.has(edge.id)).flatMap(edge => edge.evidenceIds));
        pkg.evidenceUnits = pkg.evidenceUnits.filter(evidence => !withdrawn.has(evidence.id) || retainedEvidence.has(evidence.id));
        pkg.manifest.counts.evidenceUnits = pkg.evidenceUnits.length;
        pkg.manifest.counts.contributions = pkg.contributions.length;
        pkg.manifest.counts.provenanceEdges = pkg.provenanceEdges.length;
        if (pkg.claims.some(claim => claim.originality === "unresolved")) pkg.manifest.status = "draft";
        pkg.manifest.capabilities = [...new Set([...pkg.manifest.capabilities, "local-attribution-reviewed"])];
        await writeContextPackage(pkg, archiveSource);
      }
      const output = path.join(temporary, "context.zip");
      await makeZip(archiveSource, output);
      await rename(output, target);
      return target;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async getOverview(contextId: string, version = "0.1.0") {
    const pkg = await loadContextPackage(this.root(contextId, version));
    return { manifest: pkg.manifest, theses: pkg.theses, axioms: pkg.axioms };
  }
  async search(contextId: string, query: string, options: { version?: string; limit?: number; sourceFamilyLimit?: number } = {}) {
    const { pkg, originalEdges } = await this.reviewedPackage(contextId, options.version);
    const surviving = new Set(pkg.provenanceEdges.flatMap(edge => edge.evidenceIds));
    const withdrawn = new Set(originalEdges.flatMap(edge => edge.evidenceIds).filter(id => !surviving.has(id)));
    const queryTerms = terms(query.slice(0, 512));
    const claimText = pkg.claims.map(claim => ({ claim, text: `${claim.text} ${claim.tags.join(" ")}`.toLowerCase() }));
    const termWeights = queryTerms.map(term => ({
      term,
      weight: Math.log1p(claimText.length / (1 + claimText.filter(item => item.text.includes(term)).length)),
    }));
    const lexical = (text: string) => {
      const haystack = text.toLowerCase();
      return termWeights.reduce((total, { term, weight }) =>
        total + (haystack.includes(term) ? weight * Math.min(2, term.length / 2) : 0), 0);
    };
    const claimsByEvidence = new Map<string, { ids: string[]; score: number }>();
    for (const { claim, text } of claimText) {
      const score = lexical(text);
      for (const id of claim.evidenceIds) {
        const prior = claimsByEvidence.get(id);
        claimsByEvidence.set(id, { ids: [...(prior?.ids ?? []), claim.id], score: Math.max(prior?.score ?? 0, score) });
      }
    }
    const docs = new Map(pkg.documents.map((x) => [x.id, x]));
    const familyCount = new Map<string, number>();
    const seenClaims = new Set<string>();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const indexed = indexCandidates(this.root(contextId, options.version), queryTerms, pkg.manifest.hashes["evidence/units.jsonl"]);
    const ranked = pkg.evidenceUnits
      .filter(evidence => !withdrawn.has(evidence.id) &&
        (!indexed?.size || indexed.has(evidence.id) || (claimsByEvidence.get(evidence.id)?.score ?? 0) > 0))
      .map(evidence => {
        const document = docs.get(evidence.documentId)!;
        const match = claimsByEvidence.get(evidence.id);
        return { evidence, document,
          score: lexical(evidence.text) + (match?.score ?? 0) * 2.2,
          claimIds: match?.ids ?? [],
        };
      })
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.evidence.verified) - Number(a.evidence.verified));
    const results: SearchHit[] = [];
    const add = (hit: SearchHit) => {
      const count = familyCount.get(hit.document.sourceFamily) ?? 0;
      if (count >= (options.sourceFamilyLimit ?? 3)) return;
      familyCount.set(hit.document.sourceFamily, count + 1);
      hit.claimIds.forEach(id => seenClaims.add(id));
      results.push(hit);
    };
    for (const hit of ranked) {
      if (results.length === limit) break;
      if (!hit.claimIds.length || hit.claimIds.some(id => !seenClaims.has(id))) add(hit);
    }
    if (results.length < limit) {
      const selected = new Set(results.map(hit => hit.evidence.id));
      for (const hit of ranked) {
        if (results.length === limit) break;
        if (!selected.has(hit.evidence.id)) add(hit);
      }
    }
    return results;
  }
  async traceClaim(contextId: string, claimId: string, version = "0.1.0") {
    const { pkg, reviews } = await this.reviewedPackage(contextId, version);
    const claim = pkg.claims.find((x) => x.id === claimId);
    if (!claim) throw new TaskError("NOT_FOUND", "Claim 不存在");
    const evidence = pkg.evidenceUnits.filter((x) => claim.evidenceIds.includes(x.id));
    const documents = pkg.documents.filter((x) => evidence.some((e) => e.documentId === x.id) || pkg.provenanceEdges.some((edge) => edge.fromClaimId === claimId && edge.toSourceId === x.id));
    return { claim, evidence, documents, review: reviews.find(item => item.claimId === claimId), provenance: pkg.provenanceEdges.filter((x) => x.fromClaimId === claimId || x.toClaimId === claimId), contributions: pkg.contributions.filter((x) => x.claimId === claimId) };
  }
  async readEvidence(contextId: string, evidenceId: string, version = "0.1.0") {
    const { pkg } = await this.reviewedPackage(contextId, version);
    const evidence = pkg.evidenceUnits.find((x) => x.id === evidenceId);
    if (!evidence) throw new TaskError("NOT_FOUND", "EvidenceUnit 不存在");
    return { evidence, document: pkg.documents.find((x) => x.id === evidence.documentId) };
  }
  async buildContextPacket(contextId: string, query: string, options: { version?: string; maxChars?: number; limit?: number } = {}) {
    const { pkg, reviews } = await this.reviewedPackage(contextId, options.version);
    const hits = await this.search(contextId, query, { version: options.version, limit: options.limit ?? 12 });
    const queryTerms = terms(query.slice(0, 512));
    const directlyMatchedClaims = pkg.claims
      .map((claim) => ({ claim, score: lexicalScore(`${claim.text} ${claim.tags.join(" ")}`, queryTerms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.claim.weight - a.claim.weight)
      .slice(0, 8)
      .map((x) => x.claim.id);
    const claimIds = [...new Set([...hits.flatMap((x) => x.claimIds), ...directlyMatchedClaims])]
      .map((id) => pkg.claims.find((x) => x.id === id))
      .filter((x): x is Claim => Boolean(x))
      .sort((a, b) => lexicalScore(`${b.text} ${b.tags.join(" ")}`, queryTerms) - lexicalScore(`${a.text} ${a.tags.join(" ")}`, queryTerms) || b.weight - a.weight)
      .slice(0, 8)
      .map((claim) => claim.id);
    const claims = claimIds.map((id) => pkg.claims.find((x) => x.id === id)).filter((x): x is Claim => Boolean(x));
    const relatedStatements = [...pkg.theses, ...pkg.axioms].filter((x) => x.claimIds.some((id) => claimIds.includes(id)));
    const maxChars = Math.max(1_000, Math.min(options.maxChars ?? 20_000, 80_000));
    const docs = new Map(pkg.documents.map((x) => [x.id, x]));
    const evidenceMap = new Map(pkg.evidenceUnits.map((x) => [x.id, x]));
    const expandedEvidence = [...hits];
    for (const claim of claims) for (const id of claim.evidenceIds.slice(0, 2)) {
      const evidence = evidenceMap.get(id), document = evidence && docs.get(evidence.documentId);
      if (evidence && document && !expandedEvidence.some((x) => x.evidence.id === id)) expandedEvidence.push({ evidence, document, score: claim.weight, claimIds: [claim.id] });
    }
    for (const claim of claims) {
      const upstreamEvidenceIds = pkg.provenanceEdges
        .filter((edge) => edge.fromClaimId === claim.id)
        .sort((a, b) => b.coverage * b.confidence - a.coverage * a.confidence)
        .flatMap((edge) => edge.evidenceIds)
        .slice(0, 2);
      for (const id of upstreamEvidenceIds) {
        const evidence = evidenceMap.get(id), document = evidence && docs.get(evidence.documentId);
        if (evidence && document && !expandedEvidence.some((item) => item.evidence.id === id))
          expandedEvidence.push({ evidence, document, score: claim.weight + 1, claimIds: [claim.id] });
      }
    }
    const origins = confirmedOrigins(pkg);
    const recommendations: any[] = [];
    const seenFamily = new Set<string>();
    for (const claim of claims) {
      const upstream = pkg.provenanceEdges.filter((edge) => edge.fromClaimId === claim.id && edge.toSourceId).sort((a, b) => b.confidence * b.coverage - a.confidence * a.coverage);
      const candidates: { document?: SourceDocument; reason: string; kind: string }[] = [];
      if (claim.originality === "derivative" || claim.originality === "mixed")
        for (const edge of upstream.filter(edge => origins.has(edge.id))) candidates.push({ document: docs.get(edge.toSourceId!), reason: `原作涵盖此观点约 ${Math.round(edge.coverage * 100)}% 的内容`, kind: "upstream" });
      if (claim.originality === "original" || claim.originality === "mixed" || !candidates.length) {
        const note = pkg.documents.find((x) => x.noteId === claim.noteId);
        candidates.push({ document: note, reason: claim.originality === "original" ? "有界查源未发现可信更早来源，推荐查看创作者原笔记" : "查看创作者如何解释、应用或重组该观点", kind: "creator-note" });
      }
      for (const edge of upstream) {
        const document = docs.get(edge.toSourceId!);
        if (document?.contentStatus === "metadata-only" && document.url)
          candidates.push({ document, kind: "reading-lead", reason: "可进一步查阅的材料" });
      }
      for (const candidate of candidates) {
        if (!candidate.document || !candidate.document.url || seenFamily.has(candidate.document.sourceFamily)) continue;
        seenFamily.add(candidate.document.sourceFamily);
        recommendations.push({ kind: candidate.kind, title: candidate.document.title, url: candidate.document.url, accessType: candidate.document.accessType, reason: candidate.reason, claimId: claim.id });
        if (recommendations.length >= 4) break;
      }
      if (recommendations.length >= 4) break;
    }
    const evidence = expandedEvidence
      .sort((a, b) => b.score - a.score || Number(b.evidence.verified) - Number(a.evidence.verified))
      .map((hit) => ({ id: hit.evidence.id, text: hit.evidence.text, locator: hit.evidence.locator, verified: hit.evidence.verified, source: { id: hit.document.id, title: hit.document.title, author: hit.document.author, url: hit.document.url, sourceFamily: hit.document.sourceFamily, accessType: hit.document.accessType }, claimIds: hit.claimIds }));
    const conciseClaims = claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      originality: claim.originality,
      originalityBasis: claim.originalityBasis,
      sourceCoverage: claim.sourceCoverage,
      creatorContribution: claim.creatorContribution,
      contributionDescription: pkg.contributions.find(item => item.claimId === claim.id)?.description,
      reviewReason: reviews.find(item => item.claimId === claim.id)?.reason,
    }));
    const conciseStatements = relatedStatements.map((statement) => ({
      id: statement.id,
      kind: statement.kind,
      title: statement.title,
      statement: statement.statement,
      conditions: statement.conditions,
      exceptions: statement.exceptions,
      claimIds: statement.claimIds,
    }));
    const packet = {
      context: { id: pkg.manifest.contextId, version: pkg.manifest.version, name: pkg.manifest.name, status: pkg.manifest.status },
      query,
      answerProtocol: ["先回答当前决策或任务", "区分上游事实、博主贡献和当前推导", "只引用 Evidence Packet 中的证据", "给出下一步行动", "推荐 2–4 个最相关来源并说明理由"],
      statements: conciseStatements,
      claims: conciseClaims,
      layers: {
        sourceTruth: evidence.filter((item) => !item.source.id.startsWith("xhs-")).map((item) => item.id),
        creatorInterpretation: evidence.filter((item) => item.source.id.startsWith("xhs-")).map((item) => item.id),
        currentInference: [] as string[],
      },
      evidence,
      recommendations,
    };
    let encoded = JSON.stringify(packet);
    while (encoded.length > maxChars && packet.evidence.length > 1) {
      packet.evidence.pop();
      const remaining = new Set(packet.evidence.map((item) => item.id));
      packet.layers.sourceTruth = packet.layers.sourceTruth.filter((id) => remaining.has(id));
      packet.layers.creatorInterpretation = packet.layers.creatorInterpretation.filter((id) => remaining.has(id));
      encoded = JSON.stringify(packet);
    }
    return { ...packet, truncated: encoded.length > maxChars };
  }
}
