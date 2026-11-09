import path from "node:path";
import {
  Distiller,
  config,
  migrateLegacyJob,
  buildContextIndex,
  finalizeAttemptedOriginality,
  ContextRuntime,
  loadContextPackage,
  reconstructProvenance,
  synthesizeContext,
  JobInputBudget,
  TokenBudget,
  hash,
  json,
  redact,
  verifyContextDirectory,
  writeContextPackage,
} from "../packages/sdk/src/index.ts";
import { seeds } from "./seed.ts";
const sdk = new Distiller(config());
const [command, id, secondary] = process.argv.slice(2);
if (command === "inspect") console.log(await sdk.inspectEnvironment());
else if (command === "seed") {
  if (!seeds.length) throw new Error("请将笔记链接保存为数据目录中的 seed-links.json 数组");
  const p = id ? sdk.store.project(id) : sdk.createProject(
    "导入的精选材料", "creator-advisor", Math.max(10, seeds.length),
  );
  await sdk.importNoteLinks(p.id, seeds);
  sdk.updateProject(p.id, {
    selected: sdk.store.project(p.id).notes.map((n) => n.id),
  });
  console.log(p.id);
} else if (command === "hydrate") {
  await sdk.hydrate(id);
  await sdk.tasks.get("metadata:" + id);
  console.log(
    sdk.store.project(id).notes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      status: n.status,
      error: n.error,
    })),
  );
} else if (command === "fetch") {
  for (const n of sdk.store.project(id).notes) {
    try {
      const r = await sdk.fetchNote(id, n.id);
      console.log(
        JSON.stringify({
          id: n.id,
          title: r.note.title,
          type: r.note.type,
          media: r.media.length,
          status: "complete",
        }),
      );
    } catch (e: any) {
      console.log(JSON.stringify({ id: n.id, error: redact(e.message) }));
      if (
        ["AUTH_REQUIRED", "SECURITY_BLOCK", "BROWSER_CONNECT"].includes(e.code)
      )
        break;
    }
  }
} else if (command === "distill") {
  const j = sdk.startDistillation(id);
  console.log(j.id);
  const timer = setInterval(() => {
    const x = sdk.getJob(j.id);
    console.log(
      JSON.stringify({
        id: x.id,
        status: x.status,
        stage: x.stage,
        notes: x.noteStates,
        error: x.error,
      }),
    );
  }, 30000);
  await sdk.waitJob(j.id);
  clearInterval(timer);
  console.log(sdk.getJob(j.id));
} else if (command === "resume") {
  sdk.resumeJob(id, { offline: process.argv.includes("--offline") });
  await sdk.waitJob(id);
  console.log(sdk.getJob(id));
} else if (command === "status")
  console.log(
    JSON.stringify(
      {
        projects: sdk.store
          .list<any>("project")
          .map((p) => ({
            id: p.id,
            name: p.name,
            skillName: p.skillName,
            selected: p.selected.length,
            notes: p.notes.length,
          })),
        jobs: sdk.store
          .list<any>("job")
          .map((j) => ({
            id: j.id,
            status: j.status,
            stage: j.stage,
            error: j.error,
            notes: j.noteStates,
          })),
      },
      null,
      2,
    ),
  );
else if (command === "context:migrate") {
  if (!id || !secondary)
    throw new Error("用法：context:migrate PROJECT_ID JOB_ID [CONTEXT_ID]");
  const project = sdk.store.project(id);
  const contextId = process.argv[5] || project.skillName;
  const pkg = await migrateLegacyJob({
    dataDir: sdk.cfg.dataDir,
    projectId: id,
    jobId: secondary,
    contextId,
    name: project.name,
    purpose: project.purpose,
  });
  const directory = path.join(
    sdk.cfg.dataDir,
    "contexts",
    contextId,
    pkg.manifest.version,
  );
  const previous = await json<typeof pkg.manifest>(path.join(directory, "manifest.json"));
  if (previous?.sourceJobId === secondary) {
    const budget = new JobInputBudget(sdk.store, secondary);
    budget.seedLegacy(previous.tokenBudget.cumulativeUsed ?? previous.tokenBudget.used);
    throw new Error("同一任务已迁移，请使用 context:build 继续现有 Context。");
  }
  await writeContextPackage(pkg, directory);
  console.log(JSON.stringify({ directory, manifest: pkg.manifest }, null, 2));
} else if (command === "context:verify") {
  if (!id) throw new Error("用法：context:verify CONTEXT_ID [VERSION]");
  const directory = path.join(
    sdk.cfg.dataDir,
    "contexts",
    id,
    secondary || "0.1.0",
  );
  console.log(JSON.stringify(await verifyContextDirectory(directory), null, 2));
} else if (command === "context:index") {
  if (!id) throw new Error("用法：context:index CONTEXT_ID [VERSION]");
  const directory = path.join(sdk.cfg.dataDir, "contexts", id, secondary || "0.1.0");
  console.log(await buildContextIndex(directory));
} else if (command === "context:register") {
  if (!id) throw new Error("用法：context:register CONTEXT_ID [VERSION]");
  console.log(JSON.stringify(await new ContextRuntime(sdk.cfg.dataDir).register(id, secondary || "0.1.0"), null, 2));
} else if (command === "context:search") {
  if (!id || !secondary) throw new Error("用法：context:search CONTEXT_ID QUERY");
  console.log(JSON.stringify(await new ContextRuntime(sdk.cfg.dataDir).search(id, secondary), null, 2));
} else if (command === "context:build") {
  if (!id) throw new Error("用法：context:build CONTEXT_ID [VERSION]");
  const version = secondary || "0.1.0";
  const directory = path.join(sdk.cfg.dataDir, "contexts", id, version);
  const workDir = path.join(sdk.cfg.dataDir, "context-builds", id, version);
  let pkg = await loadContextPackage(directory);
  const jobId = pkg.manifest.sourceJobId || `context:${id}:${version}`;
  const durableBudget = new JobInputBudget(sdk.store, jobId);
  durableBudget.seedLegacy(pkg.manifest.tokenBudget.cumulativeUsed ?? pkg.manifest.tokenBudget.used);
  await sdk.model.within!(jobId, async () => {
    const priorRuns = pkg.manifest.tokenBudget.runs ?? (pkg.manifest.tokenBudget.used > 0 ? 1 : 0);
    const budget = new TokenBudget(pkg.manifest.tokenBudget.hardLimit, pkg.manifest.tokenBudget.degradedAt);
    const mark = (stage: any, status: any, tokens = 0) => {
      const record = pkg.manifest.stages.find((x) => x.stage === stage);
      if (record) Object.assign(record, { status, inputTokens: tokens, attempts: record.attempts + 1, completedAt: status === "complete" ? new Date().toISOString() : undefined, outputHash: status === "complete" ? hash(JSON.stringify({ stage, counts: pkg.manifest.counts })) : null });
    };
    mark("discover", "running");
    const provenance = await reconstructProvenance(sdk.model, pkg, workDir, budget, undefined, async (checkpoint, batch) => {
      checkpoint.manifest.description = `自动查源进行中，已完成 ${batch} 个批次。`;
      checkpoint.manifest.tokenBudget.cumulativeUsed = durableBudget.used();
      await writeContextPackage(checkpoint, directory);
    });
    pkg = provenance.pkg;
    finalizeAttemptedOriginality(pkg.claims);
    const provenanceStatus = provenance.complete ? "complete" : "paused";
    mark("discover", provenanceStatus, budget.stageUsed("discover"));
    mark("verify", provenanceStatus);
    mark("attribute", provenanceStatus);
    mark("synthesize", "running");
    ({ pkg } = await synthesizeContext(sdk.model, pkg, workDir, budget));
    mark("synthesize", "complete", budget.stageUsed("synthesize"));
    pkg.manifest.tokenBudget.used = durableBudget.used();
    pkg.manifest.tokenBudget.cumulativeUsed = durableBudget.used();
    pkg.manifest.tokenBudget.runs = priorRuns + 1;
    mark("package", "running");
    const unresolved = pkg.claims.filter((x) => x.originality === "unresolved").length;
    pkg.manifest.description = provenance.complete
      ? `已完成 ${pkg.claims.length} 项 Claim 的自动查源与 Context 综合。`
      : `已完成 ${provenance.traceAttemptedClaims}/${pkg.claims.length} 项 Claim 的自动查源；受单任务 token 安全上限约束，其余 Claim 保持待处理。`;
    pkg.manifest.status = unresolved === 0 && pkg.theses.length > 0 && pkg.axioms.length > 0 ? "complete" : "draft";
    pkg.manifest.capabilities = [...new Set([...pkg.manifest.capabilities, "source-provenance", "creator-contributions", "core-theses", "public-axioms", "mcp-runtime"])];
    await writeContextPackage(pkg, directory);
    mark("package", "complete");
    mark("index", "running");
    await buildContextIndex(directory);
    mark("index", "complete");
    mark("evaluate", "running");
    const runtime = new ContextRuntime(sdk.cfg.dataDir);
    const smokePacket = await runtime.buildContextPacket(id, pkg.claims[0]?.text || pkg.manifest.purpose || "核心方法", { version, maxChars: 12_000, limit: 5 });
    if (!smokePacket.evidence.length) throw new Error("Context 检索未返回可引用证据");
    mark("evaluate", "complete");
    mark("register", "running");
    await runtime.register(id, version);
    mark("register", "complete");
    await writeContextPackage(pkg, directory);
    await buildContextIndex(directory);
    const summary = { contextId: id, version, status: pkg.manifest.status, provenanceComplete: provenance.complete, processedClaimsThisRun: provenance.processedClaimIds.length, traceAttemptedClaims: provenance.traceAttemptedClaims, counts: pkg.manifest.counts, unresolved, tokenBudget: pkg.manifest.tokenBudget, directory };
    console.log(JSON.stringify(summary, null, 2));
  });
}
else
  console.log(
    "Commands: inspect | seed | hydrate PROJECT | fetch PROJECT | distill PROJECT | resume JOB | status | context:migrate PROJECT JOB [CONTEXT] | context:build CONTEXT [VERSION] | context:verify CONTEXT [VERSION] | context:index CONTEXT [VERSION] | context:register CONTEXT [VERSION] | context:search CONTEXT QUERY",
  );
sdk.store.close();
