import { TaskError } from "../util.ts";

export const CONTEXT_SCHEMA_VERSION = "1.0.0" as const;

export type ExportProfile = "local-full" | "portable-safe";
export type AccessType = "public" | "paywalled" | "private" | "deleted" | "unknown";
export type RightsScope = "local-only" | "link-only" | "redistributable" | "unknown";
export type SourceKind = "xiaohongshu-note" | "article" | "paper" | "report" | "video" | "book" | "restricted" | "other";
export type EvidenceKind = "body" | "image" | "audio" | "frame" | "subtitle" | "source-text" | "metadata";
export type ClaimType = "fact" | "viewpoint" | "framework" | "experience" | "recommendation" | "question";
export type Originality = "original" | "derivative" | "mixed" | "unresolved";

export type MediaLocator = {
  kind: "body" | "image" | "video" | "audio" | "frame" | "url";
  page?: number;
  region?: { x: number; y: number; width: number; height: number };
  start?: number;
  end?: number;
  segmentId?: string;
  assetRef?: string;
  url?: string;
};

export type SourceDocument = {
  version: 1;
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  canonicalUrl: string | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  sourceFamily: string;
  accessType: AccessType;
  rightsScope: RightsScope;
  contentStatus: "full" | "partial" | "metadata-only";
  noteId?: string;
  fetchedAt?: string;
  metadata?: Record<string, unknown>;
};

export type EvidenceUnit = {
  version: 1;
  id: string;
  documentId: string;
  kind: EvidenceKind;
  text: string;
  locator: MediaLocator;
  verified: boolean;
  confidence: number | null;
  language: string;
  sourceHash: string;
};

export type Claim = {
  version: 1;
  id: string;
  type: ClaimType;
  text: string;
  weight: number;
  evidenceIds: string[];
  originality: Originality;
  originalityBasis: string;
  sourceCoverage: number;
  creatorContribution: number;
  upstreamClaimIds: string[];
  tags: string[];
  noteId?: string;
  legacyMethodId?: string;
  temporal?: { sensitivity: "time-sensitive" | "durable-principle" | "unknown"; sourceDate: string | null; reason: string };
};

export type ProvenanceRelation = "quotes" | "paraphrases" | "translates" | "summarizes" | "applies" | "extends" | "critiques" | "curates" | "supports";

export type ProvenanceEdge = {
  version: 1;
  id: string;
  fromClaimId: string;
  toSourceId?: string;
  toClaimId?: string;
  relation: ProvenanceRelation;
  coverage: number;
  confidence: number;
  evidenceIds: string[];
  sourceFamily: string;
  depth: number;
  verified: boolean;
};

export type CreatorContribution = {
  version: 1;
  id: string;
  claimId: string;
  type: "new-conclusion" | "explanation" | "application" | "critique" | "case" | "reorganization" | "selection" | "translation-only";
  description: string;
  creatorEvidenceIds: string[];
  upstreamClaimIds: string[];
  score: number;
};

export type ContextStatement = {
  version: 1;
  id: string;
  title: string;
  statement: string;
  scope: string[];
  conditions: string[];
  exceptions: string[];
  claimIds: string[];
  conflicts: string[];
  temporal?: { sensitivity: "time-sensitive" | "durable-principle" | "unknown"; sourceDate: string | null; reason: string };
};

export type CoreThesis = ContextStatement & { kind: "thesis" };
export type PublicAxiom = ContextStatement & { kind: "axiom" };

export type StageName = "acquire" | "clean" | "unitize" | "discover" | "verify" | "attribute" | "synthesize" | "index" | "evaluate" | "package" | "register";
export type StageRecord = {
  stage: StageName;
  status: "pending" | "running" | "paused" | "failed" | "complete" | "skipped";
  inputHash: string;
  processorVersion: string;
  outputHash: string | null;
  inputTokens: number;
  elapsedMs: number;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type ContextManifest = {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  contextId: string;
  version: string;
  name: string;
  description: string;
  creator: string | null;
  purpose: string;
  status: "draft" | "complete";
  exportProfile: ExportProfile;
  createdAt: string;
  updatedAt: string;
  sourceProjectId: string;
  sourceJobId: string;
  counts: { documents: number; evidenceUnits: number; claims: number; theses: number; axioms: number; provenanceEdges: number; contributions: number };
  tokenBudget: { hardLimit: number; used: number; degradedAt: number; cumulativeUsed?: number; runs?: number };
  capabilities: string[];
  stages: StageRecord[];
  hashes: Record<string, string>;
};

export type ContextPackage = {
  manifest: ContextManifest;
  documents: SourceDocument[];
  evidenceUnits: EvidenceUnit[];
  claims: Claim[];
  provenanceEdges: ProvenanceEdge[];
  contributions: CreatorContribution[];
  theses: CoreThesis[];
  axioms: PublicAxiom[];
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TaskError("CONTEXT_SCHEMA", message);
}

function score(value: number, label: string) {
  requireValue(Number.isFinite(value) && value >= 0 && value <= 1, `${label} 必须在 0 到 1 之间`);
}

export function validateContextPackage(pkg: ContextPackage) {
  requireValue(pkg.manifest.schemaVersion === CONTEXT_SCHEMA_VERSION, "不支持的 Context Schema 版本");
  requireValue(/^[a-z0-9][a-z0-9_-]{1,63}$/.test(pkg.manifest.contextId), "contextId 不合法");
  requireValue(pkg.manifest.tokenBudget.used <= pkg.manifest.tokenBudget.hardLimit, "任务超过模型输入硬上限");
  const documents = new Map(pkg.documents.map((x) => [x.id, x]));
  const evidence = new Map(pkg.evidenceUnits.map((x) => [x.id, x]));
  const claims = new Map(pkg.claims.map((x) => [x.id, x]));
  requireValue(documents.size === pkg.documents.length, "SourceDocument id 重复");
  requireValue(evidence.size === pkg.evidenceUnits.length, "EvidenceUnit id 重复");
  requireValue(claims.size === pkg.claims.length, "Claim id 重复");
  for (const unit of pkg.evidenceUnits) {
    requireValue(documents.has(unit.documentId), `EvidenceUnit ${unit.id} 缺少来源文档`);
    requireValue(unit.text.trim().length > 0, `EvidenceUnit ${unit.id} 文本为空`);
    if (unit.locator.page !== undefined) requireValue(unit.locator.page >= 1, `EvidenceUnit ${unit.id} 页码无效`);
    if (unit.locator.start !== undefined || unit.locator.end !== undefined) {
      requireValue(unit.locator.start !== undefined && unit.locator.end !== undefined && unit.locator.start >= 0 && unit.locator.end >= unit.locator.start, `EvidenceUnit ${unit.id} 时间码无效`);
    }
  }
  for (const claim of pkg.claims) {
    score(claim.sourceCoverage, `${claim.id}.sourceCoverage`);
    score(claim.creatorContribution, `${claim.id}.creatorContribution`);
    requireValue(claim.evidenceIds.length > 0, `Claim ${claim.id} 缺少证据`);
    for (const id of claim.evidenceIds) requireValue(evidence.has(id), `Claim ${claim.id} 引用了不存在的证据 ${id}`);
  }
  for (const edge of pkg.provenanceEdges) {
    requireValue(claims.has(edge.fromClaimId), `来源边 ${edge.id} 缺少起点 Claim`);
    requireValue(Boolean(edge.toSourceId) !== Boolean(edge.toClaimId), `来源边 ${edge.id} 必须且只能有一个终点`);
    if (edge.toSourceId) requireValue(documents.has(edge.toSourceId), `来源边 ${edge.id} 缺少目标来源`);
    if (edge.toClaimId) requireValue(claims.has(edge.toClaimId), `来源边 ${edge.id} 缺少目标 Claim`);
    score(edge.coverage, `${edge.id}.coverage`);
    score(edge.confidence, `${edge.id}.confidence`);
  }
  for (const item of [...pkg.theses, ...pkg.axioms]) {
    requireValue(item.claimIds.length > 0, `${item.id} 缺少 Claim`);
    for (const id of item.claimIds) requireValue(claims.has(id), `${item.id} 引用了不存在的 Claim ${id}`);
  }
  for (const contribution of pkg.contributions) {
    requireValue(claims.has(contribution.claimId), `贡献 ${contribution.id} 缺少 Claim`);
    score(contribution.score, `${contribution.id}.score`);
  }
  return pkg;
}
