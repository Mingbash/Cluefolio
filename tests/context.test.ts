import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import {
  JobInputBudget,
  TokenBudget,
  classifyOriginality,
  dedupeSourceFamilies,
  finalizeAttemptedOriginality,
  canonicalSourceUrl,
  migrateLegacyJob,
  validateContextPackage,
  verifyContextDirectory,
  writeContextPackage,
  buildContextIndex,
  ContextRuntime,
  toolDefinitions,
} from "../packages/sdk/src/context/index.ts";
import { Store } from "../packages/sdk/src/store.ts";
import { atomic } from "../packages/sdk/src/util.ts";

test("originality protects new conclusions built on sourced facts", () => {
  assert.deepEqual(
    classifyOriginality({
      sourceCoverage: 0.92,
      creatorContribution: 0.76,
      boundedSearchComplete: true,
      crediblePriorMatch: true,
    }),
    {
      originality: "mixed",
      basis: "high_upstream_coverage_with_creator_contribution",
    },
  );
  assert.equal(
    classifyOriginality({
      sourceCoverage: 0.92,
      creatorContribution: 0.12,
      boundedSearchComplete: true,
      crediblePriorMatch: true,
    }).originality,
    "derivative",
  );
});

test("bounded search may classify original except inaccessible or unresolved prior sources", () => {
  assert.equal(
    classifyOriginality({
      sourceCoverage: 0,
      creatorContribution: 0.8,
      boundedSearchComplete: true,
      crediblePriorMatch: false,
    }).originality,
    "original",
  );
  assert.equal(
    classifyOriginality({
      sourceCoverage: 0,
      creatorContribution: 0.8,
      boundedSearchComplete: true,
      crediblePriorMatch: false,
      explicitSourceInaccessible: true,
    }).originality,
    "unresolved",
  );
});

test("an attempted search resolves partial upstream support without erasing creator contribution", () => {
  const claims: any[] = [{ originality: "unresolved", originalityBasis: "insufficient_attribution_evidence", sourceCoverage: 0.55, creatorContribution: 0.45 }];
  finalizeAttemptedOriginality(claims);
  assert.equal(claims[0].originality, "mixed");
  assert.equal(claims[0].originalityBasis, "partial_upstream_relation_with_creator_contribution");
  assert.equal(classifyOriginality({ sourceCoverage: 0, creatorContribution: 0.4, boundedSearchComplete: false, crediblePriorMatch: false }).originality, "original");
});

test("source-family dedupe keeps the strongest representative", () => {
  const edge = (id: string, confidence: number, coverage: number) => ({
    version: 1 as const,
    id,
    fromClaimId: "c1",
    toSourceId: id,
    relation: "supports" as const,
    coverage,
    confidence,
    evidenceIds: [],
    sourceFamily: "same-original",
    depth: 1,
    verified: true,
  });
  assert.deepEqual(dedupeSourceFamilies([edge("translation", 0.7, 0.8), edge("original", 0.95, 0.9)]).map((x) => x.id), ["original"]);
});

test("upstream article URLs discard search and campaign residue", () => {
  assert.equal(
    canonicalSourceUrl("https://www.ycombinator.com/blog/how-to-raise-a-seed-round/?filter_by=type&q=bing&utm_source=test"),
    "https://www.ycombinator.com/blog/how-to-raise-a-seed-round/",
  );
  assert.equal(
    canonicalSourceUrl("https://www.ycombinator.com/blog/how-to-raise-a-seed-round/?filter_by%3Dtype%3A%3D=landingPages%2CsitePages&q=l%3A%2F%2Fwww.bing.com%2Fsearch"),
    "https://www.ycombinator.com/blog/how-to-raise-a-seed-round/",
  );
});

test("token budget degrades at 80 percent and refuses more than 1M", () => {
  const budget = new TokenBudget();
  budget.consume("unitize", 799_999);
  assert.equal(budget.degraded(), false);
  budget.consume("discover", 1);
  assert.equal(budget.degraded(), true);
  assert.throws(() => budget.consume("verify", 200_001), /硬上限/);
});

test("job input reservations survive closing, reopening, and failed delivery", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new Store(root);
  const a = new JobInputBudget(first, "job");
  a.seedLegacy(710_000);
  a.charge(240_000);
  first.close(); // An interrupted request leaves its reservation intact.
  const second = new Store(root);
  const third = new Store(root);
  try {
    const b = new JobInputBudget(second, "job");
    const c = new JobInputBudget(third, "job");
    b.seedLegacy(1);
    assert.equal(b.used(), 950_000);
    b.charge(49_999);
    assert.throws(() => c.charge(2), /累计模型输入/);
    c.charge(1);
    assert.equal(b.used(), 1_000_000);
    assert.throws(() => c.charge(1), /累计模型输入/);
    assert.equal(new JobInputBudget(second, "separate-job").used(), 0);
    c.seedLegacy(2_093_965);
    assert.throws(() => c.charge(1), /累计模型输入/);
  } finally {
    second.close();
    third.close();
  }
});

test("a local job migrates, tracks provenance, and applies reversible review", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "context-runtime-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectId = "demo-project", jobId = "demo-job", contextId = "demo-context";
  const noteId = "000000000000000000000001";
  const root = path.join(dataDir, "projects", projectId, "jobs", jobId);
  await atomic(path.join(root, "sources", noteId + ".json"), {
    id: noteId, title: "访谈准备", inputHash: "fixture", issues: [],
    segments: [{ id: "audio-1", kind: "audio", text: "客户痛点与解决方案是两个问题。项目价值和投资价值要分别验证。", start: 17, end: 29 }],
  });
  await atomic(path.join(root, "methods.json"), [{
    id: "demo-method", title: "如何检查痛点和解决方案", problem: "客户痛点未经访谈证实",
    conditions: [], level: "explicit", evidence: [{ noteId, segmentId: "audio-1" }],
  }]);
  const pkg = await migrateLegacyJob({ dataDir, projectId, jobId, contextId });
  validateContextPackage(pkg);
  assert.equal(pkg.documents.length, 1);
  assert.equal(pkg.evidenceUnits.length, 1);
  const traced = pkg.claims[0];
  traced.text = "用明确痛点和解决方案检查需求";
  traced.originality = "mixed";
  traced.originalityBasis = "high_upstream_coverage_with_creator_contribution";
  traced.sourceCoverage = 0.8;
  traced.creatorContribution = 0.5;
  pkg.documents.push({ version: 1, id: "source-sequoia", kind: "article", title: "Writing a Business Plan", url: "https://example.com/source", canonicalUrl: "https://example.com/source", author: null, publisher: "Example", publishedAt: null, sourceFamily: "source-family", accessType: "public", rightsScope: "link-only", contentStatus: "full" });
  pkg.evidenceUnits.push({ version: 1, id: "source-sequoia-e-1", documentId: "source-sequoia", kind: "source-text", text: "Describe the problem and the customer need before presenting the solution.", locator: { kind: "url", url: "https://example.com/source" }, verified: true, confidence: 0.9, language: "en", sourceHash: "fixture" });
  pkg.provenanceEdges.push({ version: 1, id: "edge-fixture", fromClaimId: traced.id, toSourceId: "source-sequoia", relation: "summarizes", coverage: 0.8, confidence: 0.9, evidenceIds: ["source-sequoia-e-1"], sourceFamily: "source-family", depth: 1, verified: true });
  pkg.manifest.counts.documents = pkg.documents.length;
  pkg.manifest.counts.evidenceUnits = pkg.evidenceUnits.length;
  pkg.manifest.counts.provenanceEdges = pkg.provenanceEdges.length;
  const runtimeData = dataDir;
  const target = path.join(runtimeData, "contexts", contextId, "0.1.0");
  await writeContextPackage(pkg, target);
  assert.equal((await verifyContextDirectory(target)).valid, true);
  await buildContextIndex(target);
  const runtime = new ContextRuntime(runtimeData);
  const hits = await runtime.search(contextId, "投资价值 项目价值", { limit: 5 });
  assert.ok(hits.length > 0);
  assert.ok(hits.some((hit) => hit.evidence.locator.start !== undefined || hit.evidence.locator.page !== undefined || hit.evidence.locator.kind === "body"));
  const packet = await runtime.buildContextPacket(contextId, "如何检查痛点和解决方案", { maxChars: 12_000 });
  assert.ok(packet.evidence.length > 0);
  assert.ok(packet.layers.sourceTruth.includes("source-sequoia-e-1"));
  assert.ok(packet.recommendations.some((item) => item.kind === "upstream"));
  await runtime.reviewAttribution(contextId, traced.id, "0.1.0", { originality: "original", excludedEdges: ["edge-fixture"], reason: "来源只讨论通用原则" });
  const reviewed = await runtime.buildContextPacket(contextId, "如何检查痛点和解决方案");
  assert.equal(reviewed.claims[0].originality, "original");
  assert.equal(reviewed.claims[0].reviewReason, "来源只讨论通用原则");
  assert.equal(reviewed.recommendations.some(item => item.kind === "upstream"), false);
  assert.equal(reviewed.layers.sourceTruth.includes("source-sequoia-e-1"), false);
  await runtime.reviewAttribution(contextId, traced.id, "0.1.0", null);
  assert.equal((await runtime.traceClaim(contextId, traced.id)).claim.originality, "mixed");
  assert.equal((await verifyContextDirectory(target)).valid, true);
  assert.deepEqual(toolDefinitions().map((x) => x.name), ["list_contexts", "get_overview", "search", "build_context_packet", "trace_claim", "read_evidence"]);
});
