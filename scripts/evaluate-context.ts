import path from "node:path";
import { readFile } from "node:fs/promises";
import { ContextRuntime, config } from "../packages/sdk/src/index.ts";

type Labels = {
  contextId: string;
  version: string;
  retrieval: { query: string; groups: string[][] }[];
  originals: string[];
  sources: { claimId: string; urls: string[]; rationale: string }[];
};

const labelFile = process.argv[2];
if (!labelFile)
  throw new Error("用法：npm run evaluate:context -- <本机标注文件>");
const labels = JSON.parse(
  await readFile(path.resolve(labelFile), "utf8"),
) as Labels;
if (
  !labels.retrieval.length ||
  !labels.originals.length ||
  !labels.sources.some((x) => x.urls.length)
)
  throw new Error("验收须包含检索、原创和上游正例");
const runtime = new ContextRuntime(config().dataDir);
const { contextId, version } = labels;
const graph = await runtime.attribution(contextId, version);
const claims = new Map(graph.claims.map((claim) => [claim.id, claim]));
const reviewed = new Set(graph.reviews.map((review) => review.claimId));
if (
  [
    ...labels.originals,
    ...labels.sources.map((row) => row.claimId),
    ...labels.retrieval.flatMap((row) => row.groups.flat()),
  ].some((id) => !claims.has(id) || reviewed.has(id))
)
  throw new Error("标注涉及无效观点或本机手工覆盖，无法衡量自动结果");

const retrieval = await Promise.all(
  labels.retrieval.map(async (row) => {
    const hits = await runtime.search(contextId, row.query, {
      version,
      limit: 10,
    });
    const covered = new Set(hits.flatMap((hit) => hit.claimIds));
    const matches = row.groups.filter((group) =>
      group.some((id) => covered.has(id)),
    ).length;
    return { query: row.query, matches, groups: row.groups.length };
  }),
);
const originalErrors = labels.originals.filter(
  (id) => claims.get(id)!.originality === "derivative",
);
const normalUrl = (url: string) => {
  const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  return (
    parsed.hostname.replace(/^www\./, "") +
    parsed.pathname.replace(/\/$/, "").replace(/\/blog\/blog-/, "/blog/")
  );
};
const sources = await Promise.all(
  labels.sources.map(async (row) => {
    const question = claims.get(row.claimId)!.text;
    const packet = await runtime.buildContextPacket(contextId, question, {
      version,
    });
    const recs = packet.recommendations.filter(
      (item) => item.claimId === row.claimId,
    );
    const predicted = recs
      .filter((item) => item.kind === "upstream")
      .map((item) => normalUrl(item.url));
    const expected = new Set(row.urls.map(normalUrl));
    const unique = [...new Set(predicted)];
    return {
      ...row,
      predicted: unique,
      recommendedNote: recs.some((item) => item.kind === "creator-note"),
      correct: unique.filter((url) => expected.has(url)).length,
    };
  }),
);
const total = sources.reduce((sum, row) => sum + row.predicted.length, 0);
const correct = sources.reduce((sum, row) => sum + row.correct, 0);
const found = sources.filter((row) => row.correct > 0).length;
const expectedPositive = sources.filter((row) => row.urls.length > 0).length;
const metrics = {
  recallAt10:
    retrieval.reduce((sum, row) => sum + row.matches / row.groups, 0) /
    retrieval.length,
  falseDerivativeRate: originalErrors.length / labels.originals.length,
  upstreamPrecision: total ? correct / total : null,
  positiveCaseCoverage: found / expectedPositive,
};
console.log(
  JSON.stringify(
    {
      contextId,
      version,
      metrics,
      retrieval,
      originals: { n: labels.originals.length, originalErrors },
      upstream: { correct, total, found, expectedPositive, cases: sources },
    },
    null,
    2,
  ),
);
if (
  metrics.recallAt10 < 0.85 ||
  metrics.falseDerivativeRate > 0.05 ||
  (metrics.upstreamPrecision ?? 0) < 0.9 ||
  found < expectedPositive
)
  process.exitCode = 1;
