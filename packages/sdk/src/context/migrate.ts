import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { hash, json } from "../util.ts";
import type { CleanNote, Method, Project, RawNote, Segment } from "../types.ts";
import type { Claim, ContextPackage, EvidenceKind, EvidenceUnit, MediaLocator, SourceDocument, StageRecord } from "./schema.ts";
import { CONTEXT_SCHEMA_VERSION, validateContextPackage } from "./schema.ts";

const canonical = (id: string) => `https://www.xiaohongshu.com/explore/${id}`;
const normalizeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");

function locator(projectId: string, noteId: string, segment: Segment): MediaLocator {
  const kind = segment.kind === "image" ? "image" : segment.kind === "frame" ? "frame" : segment.kind === "audio" || segment.kind === "subtitle" ? "video" : "body";
  return {
    kind,
    page: segment.page,
    start: segment.start,
    end: segment.end ?? (segment.kind === "frame" ? segment.start : undefined),
    segmentId: segment.id,
    assetRef: segment.imagePath ? `xhs-project://${projectId}/notes/${noteId}/${path.basename(segment.imagePath)}` : undefined,
    url: canonical(noteId),
  };
}

function evidenceKind(kind: Segment["kind"]): EvidenceKind { return kind; }

export type LegacyMigrationOptions = {
  dataDir: string;
  projectId: string;
  jobId: string;
  contextId: string;
  version?: string;
  name?: string;
  purpose?: string;
};

export async function migrateLegacyJob(options: LegacyMigrationOptions): Promise<ContextPackage> {
  const version = options.version ?? "0.1.0";
  const projectRoot = path.join(options.dataDir, "projects", options.projectId);
  const jobRoot = path.join(projectRoot, "jobs", options.jobId);
  const sourcesRoot = path.join(jobRoot, "sources");
  const project = await json<Project>(path.join(projectRoot, "project.json"));
  const legacyMethods = (await json<Method[]>(path.join(jobRoot, "methods.json"))) ?? [];
  const files = (await readdir(sourcesRoot)).filter((name) => /^[a-f0-9]{24}\.json$/.test(name)).sort();
  const documents: SourceDocument[] = [];
  const evidenceUnits: EvidenceUnit[] = [];
  const segmentEvidence = new Map<string, string>();
  for (const file of files) {
    const clean = JSON.parse(await readFile(path.join(sourcesRoot, file), "utf8")) as CleanNote;
    const raw = await json<RawNote>(path.join(projectRoot, "notes", clean.id, "raw.json"));
    const note = raw?.note ?? project?.notes.find((item) => item.id === clean.id);
    const documentId = `xhs-${clean.id}`;
    documents.push({
      version: 1,
      id: documentId,
      kind: "xiaohongshu-note",
      title: clean.title,
      url: canonical(clean.id),
      canonicalUrl: canonical(clean.id),
      author: note?.author || null,
      publisher: "小红书",
      publishedAt: note?.publishedAt || null,
      sourceFamily: documentId,
      accessType: "public",
      rightsScope: "local-only",
      contentStatus: "full",
      noteId: clean.id,
      fetchedAt: note?.fetchedAt,
      metadata: { noteType: note?.type ?? "unknown", legacyInputHash: clean.inputHash },
    });
    for (const segment of clean.segments) {
      const supplements = segment.evidenceText?.filter(text => text.trim()) ?? [];
      const text = [segment.text, ...supplements.map(value => "画面复核：" + value)].filter(value => value.trim()).join("\n\n");
      if (!text) continue;
      const id = `${documentId}-${normalizeId(segment.id)}`;
      segmentEvidence.set(`${clean.id}:${segment.id}`, id);
      evidenceUnits.push({
        version: 1,
        id,
        documentId,
        kind: evidenceKind(segment.kind),
        text,
        locator: locator(options.projectId, clean.id, segment),
        verified: !clean.issues.some((issue) => issue.critical && issue.location === segment.id),
        confidence: segment.confidence ?? null,
        language: "zh-CN",
        sourceHash: hash(text),
      });
    }
  }
  const claims: Claim[] = [];
  for (const method of legacyMethods) {
    const ids = method.evidence.map((item) => segmentEvidence.get(`${item.noteId}:${item.segmentId}`)).filter((x): x is string => Boolean(x));
    if (!ids.length) continue;
    claims.push({
      version: 1,
      id: `claim-${normalizeId(method.id)}`,
      type: "framework",
      text: `${method.title}：${method.problem}`,
      weight: method.level === "explicit" ? 0.9 : method.level === "inferred" ? 0.65 : 0.4,
      evidenceIds: [...new Set(ids)],
      originality: "unresolved",
      originalityBasis: "legacy_candidate_not_source_traced",
      sourceCoverage: 0,
      creatorContribution: method.level === "explicit" ? 0.5 : 0.3,
      upstreamClaimIds: [],
      tags: [...method.conditions.slice(0, 3), method.title],
      noteId: method.evidence[0]?.noteId,
      legacyMethodId: method.id,
    });
  }
  const now = new Date().toISOString();
  const complete = (stage: StageRecord["stage"], inputHash: string): StageRecord => ({ stage, status: "complete", inputHash, processorVersion: "legacy-migration-1", outputHash: hash(`${stage}:${inputHash}`), inputTokens: 0, elapsedMs: 0, attempts: 1, completedAt: now });
  const pending = (stage: StageRecord["stage"]): StageRecord => ({ stage, status: "pending", inputHash: "", processorVersion: "context-1", outputHash: null, inputTokens: 0, elapsedMs: 0, attempts: 0 });
  const pkg: ContextPackage = {
    manifest: {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      contextId: options.contextId,
      version,
      name: options.name ?? options.contextId,
      description: "由既有精选笔记材料迁移的 Context Package 草稿；等待自动查源、原创增量分析与综合。",
      creator: documents.find((x) => x.author)?.author ?? null,
      purpose: options.purpose ?? project?.purpose ?? "",
      status: "draft",
      exportProfile: "local-full",
      createdAt: now,
      updatedAt: now,
      sourceProjectId: options.projectId,
      sourceJobId: options.jobId,
      counts: { documents: documents.length, evidenceUnits: evidenceUnits.length, claims: claims.length, theses: 0, axioms: 0, provenanceEdges: 0, contributions: 0 },
      tokenBudget: { hardLimit: 1_000_000, used: 0, degradedAt: 800_000, cumulativeUsed: 0, runs: 0 },
      capabilities: ["evidence-locators", "legacy-method-candidates", "local-full"],
      stages: [complete("acquire", hash(JSON.stringify(documents))), complete("clean", hash(JSON.stringify(evidenceUnits))), complete("unitize", hash(JSON.stringify(claims))), ...(["discover", "verify", "attribute", "synthesize", "index", "evaluate", "package", "register"] as const).map(pending)],
      hashes: {},
    },
    documents,
    evidenceUnits,
    claims,
    provenanceEdges: [],
    contributions: [],
    theses: [],
    axioms: [],
  };
  return validateContextPackage(pkg);
}
