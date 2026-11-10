import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  Distiller,
  config,
  redact,
  json,
  TaskError,
  ContextRuntime,
} from "../../packages/sdk/src/index.ts";
import type { Job, Project } from "../../packages/sdk/src/types.ts";
export async function createApp(
  sdk = new Distiller(config()),
  root = process.cwd(),
) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const contexts = new ContextRuntime(sdk.cfg.dataDir);
  const contextBuilds = new Map<string, { status: "running" | "complete" | "failed"; pid?: number; error?: string; startedAt: string; finishedAt?: string }>();
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host || "";
    if (!/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: "仅允许本机访问" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`)
      return reply.code(403).send({ error: "不允许跨站请求" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["content-type"]?.split(";")[0] !== "application/json"
    )
      return reply.code(415).send({ error: "需要 JSON 请求" });
  });
  app.setErrorHandler((e: any, req, reply) =>
    reply
      .code(e instanceof z.ZodError ? 400 : e.code === "NOT_FOUND" ? 404 : 400)
      .send({ error: redact(e.message), code: e.code || "REQUEST" }),
  );
  const id = (r: any) => z.string().uuid().parse(r.params.id);
  const contextId = (r: any) =>
    z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/).parse(r.params.contextId);
  function coverFile(pid: string, n: { id: string; type: string }) {
    const dir = path.join(sdk.cfg.dataDir, "projects", pid, "notes", n.id);
    return [
      path.join(dir, "cover.jpg"),
      path.join(dir, "media", n.type === "video" ? "002.jpg" : "001.jpg"),
    ].find(existsSync);
  }
  function publicProject(p: Project) {
    return {
      ...p,
      notes: p.notes.map((n) => ({
        ...n,
        originalUrl: undefined,
        cover: coverFile(p.id, n)
          ? `/api/projects/${p.id}/notes/${n.id}/cover`
          : n.cover,
        url: `https://www.xiaohongshu.com/explore/${n.id}`,
        error: n.error ? redact(n.error) : undefined,
      })),
    };
  }
  app.get("/api/projects", async () =>
    sdk.store.list<Project>("project").map(publicProject),
  );
  app.post("/api/projects", async (req) => {
    const x = z
      .object({
        name: z.string().min(1),
        skillName: z.string().default("creator-advisor"),
        limit: z.number().int().min(1).max(100).default(10),
        purpose: z.string().default(""),
        tokenBudget: z.number().int().min(10_000).max(20_000_000).default(1_000_000),
      })
      .parse(req.body);
    return publicProject(
      sdk.createProject(x.name, x.skillName, x.limit, x.purpose, x.tokenBudget),
    );
  });
  app.get("/api/projects/:id", async (req) =>
    publicProject(sdk.store.project(id(req))),
  );
  app.patch("/api/projects/:id", async (req) => {
    const x = z
      .object({
        name: z.string().min(1).optional(),
        skillName: z.string().optional(),
        purpose: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        tokenBudget: z.number().int().min(10_000).max(20_000_000).optional(),
        selected: z.array(z.string()).optional(),
      })
      .strict()
      .parse(req.body);
    return publicProject(sdk.updateProject(id(req), x));
  });
  app.post("/api/projects/:id/import", async (req) => {
    const x = z
      .object({ links: z.array(z.string()).min(1).max(500) })
      .parse(req.body);
    const p = await sdk.importNoteLinks(id(req), x.links);
    void sdk.hydrate(p.id);
    return publicProject(p);
  });
  app.post("/api/projects/:id/scan", async (req) => {
    const x = z.object({ url: z.string() }).parse(req.body);
    return sdk.listAuthorNotes(id(req), x.url);
  });
  app.post("/api/projects/:id/stop-scan", async (req) => {
    sdk.cancelScan(id(req));
    return { ok: true };
  });
  app.post("/api/projects/:id/hydrate", async (req) => {
    const x = z.object({ force: z.boolean().optional() }).parse(req.body);
    void sdk.hydrate(id(req), x.force);
    return { ok: true };
  });
  app.get("/api/environment", async () => sdk.inspectEnvironment());
  app.get("/api/contexts", async () => contexts.listContexts());
  app.get("/api/contexts/:contextId/overview", async (req) =>
    contexts.getOverview(
      contextId(req),
      z.object({ version: z.string().optional() }).parse(req.query).version,
    ),
  );
  app.get("/api/contexts/:contextId/download", async (req, reply) => {
    const context = contextId(req);
    const version = z.object({ version: z.string().optional() }).parse(req.query).version || "0.1.0";
    const file = await contexts.exportPackage(context, version);
    return reply
      .header("content-disposition", `attachment; filename="${context}-${version}.zip"`)
      .type("application/zip")
      .send(await readFile(file));
  });
  app.get("/api/contexts/:contextId/build-status", async (req) =>
    contextBuilds.get(contextId(req)) ?? { status: "idle" },
  );
  app.post("/api/contexts/:contextId/build", async (req) => {
    const context = contextId(req);
    const version = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/).default("0.1.0") }).parse(req.body).version;
    if (sdk.store.list<Job>("job").some(job => job.executor === "desktop" && job.skillName === context))
      throw new TaskError("EXECUTOR", "请在 Codex 中用任务编号续跑该 Context");
    if (contextBuilds.get(context)?.status === "running") throw new TaskError("BUSY", "该 Context 已在继续查源");
    const state: { status: "running" | "complete" | "failed"; pid?: number; error?: string; startedAt: string; finishedAt?: string } = { status: "running", startedAt: new Date().toISOString() };
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts", "cli.ts"), "context:build", context, version], {
      cwd: root,
      env: { ...process.env, XHS_DATA_DIR: sdk.cfg.dataDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    state.pid = child.pid;
    contextBuilds.set(context, state);
    let error = "";
    child.stderr.on("data", (chunk) => { error = (error + chunk.toString()).slice(-4000); });
    child.once("exit", (code) => {
      state.status = code === 0 ? "complete" : "failed";
      state.error = code === 0 ? undefined : redact(error || `构建进程退出码 ${code}`);
      state.finishedAt = new Date().toISOString();
    });
    return state;
  });
  app.post("/api/contexts/:contextId/search", async (req) => {
    const body = z.object({ query: z.string().min(1), version: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }).parse(req.body);
    return contexts.search(contextId(req), body.query, body);
  });
  app.post("/api/contexts/:contextId/packet", async (req) => {
    const body = z.object({ query: z.string().min(1), version: z.string().optional(), maxChars: z.number().int().min(1000).max(80000).optional() }).parse(req.body);
    return contexts.buildContextPacket(contextId(req), body.query, body);
  });
  app.get("/api/contexts/:contextId/attribution", async (req) =>
    contexts.attribution(contextId(req), z.object({ version: z.string().optional() }).parse(req.query).version),
  );
  app.put("/api/contexts/:contextId/claims/:claimId/review", async (req) => {
    const body = z.object({
      version: z.string(),
      review: z.object({
        originality: z.enum(["original", "mixed", "derivative", "unresolved"]),
        excludedEdges: z.array(z.string()).max(100),
        reason: z.string().trim().min(1).max(2000),
        contribution: z.string().trim().max(2000).optional(),
      }).nullable(),
    }).parse(req.body);
    const { claimId } = z.object({ claimId: z.string().min(1).max(200) }).parse(req.params);
    return contexts.reviewAttribution(contextId(req), claimId, body.version, body.review);
  });
  app.put("/api/contexts/:contextId/sources/:sourceId/author", async (req) => {
    const body = z.object({
      version: z.string(),
      review: z.object({ author: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000) }).nullable(),
    }).parse(req.body);
    const { sourceId } = z.object({ sourceId: z.string().min(1).max(200) }).parse(req.params);
    return contexts.reviewAuthor(contextId(req), sourceId, body.version, body.review);
  });
  app.get("/api/contexts/:contextId/evaluation", async (req) =>
    contexts.evaluatePackage(contextId(req), z.object({ version: z.string().optional() }).parse(req.query).version),
  );
  app.get("/api/contexts/:contextId/claims/:claimId", async (req) =>
    contexts.traceClaim(
      contextId(req),
      z.string().min(1).max(200).parse((req.params as any).claimId),
      z.object({ version: z.string().optional() }).parse(req.query).version,
    ),
  );
  app.get("/api/contexts/:contextId/evidence/:evidenceId", async (req) =>
    contexts.readEvidence(
      contextId(req),
      z.string().min(1).max(240).parse((req.params as any).evidenceId),
      z.object({ version: z.string().optional() }).parse(req.query).version,
    ),
  );
  app.get("/api/jobs", async () => {
    sdk.store.recover();
    return sdk.store.list<Job>("job").map(job => sdk.getJob(job.id));
  });
  app.post("/api/projects/:id/desktop-jobs", async (req) => {
    const project = sdk.store.project(id(req));
    return sdk.prepareDesktopJob(project.id, project.selected);
  });
  app.post("/api/projects/:id/jobs", async (req) =>
    sdk.startDistillation(id(req)),
  );
  app.post("/api/jobs/:id/cancel", async (req) => sdk.cancelJob(id(req)));
  app.post("/api/jobs/:id/budget", async (req) => sdk.raiseJobBudget(id(req), z.object({ hardLimit: z.number().int().min(10_000).max(20_000_000) }).parse(req.body).hardLimit));
  app.post("/api/jobs/:id/finish-partial", async (req) => sdk.finishPartialJob(id(req)));
  app.post("/api/jobs/:id/resume", async (req) =>
    sdk.resumeJob(
      id(req),
      z.object({ offline: z.boolean().optional() }).parse(req.body),
    ),
  );
  app.get("/api/jobs/:id", async (req) => sdk.getJob(id(req)));
  app.get("/api/jobs/:id/result", async (req) => {
    const j = sdk.getJob(id(req));
    if (!j.output) return { skill: "", quality: null, methods: [] };
    let skill = "";
    try {
      skill = await readFile(
        j.context
          ? path.join(sdk.cfg.dataDir, "contexts", j.context.contextId, j.context.version, "skill", j.context.contextId, "SKILL.md")
          : path.join(j.output, "skill", j.skillName, "SKILL.md"),
        "utf8",
      );
    } catch {}
    return {
      skill,
      downloadReady:
        j.status !== "running" &&
        existsSync(path.join(j.output, j.skillName + ".zip")) &&
        existsSync(path.join(j.output, "sources.zip")),
      quality: await json(path.join(j.output, "quality.json")),
      methods: await json(path.join(j.output, "methods.json")),
    };
  });
  app.post("/api/jobs/:id/install", async (req) => ({
    path: await sdk.install(id(req)),
  }));
  app.get("/api/jobs/:id/download", async (req, reply) => {
    const j = sdk.getJob(id(req));
    if (j.status === "running")
      throw new TaskError("NOT_READY", "本次任务尚未打包完成");
    const source = (req.query as any).sources === "true";
    const file = source
      ? path.join(j.output || "", "sources.zip")
      : await sdk.exportBundle(j.id);
    if (!j.output) throw new TaskError("NOT_READY", "尚未生成");
    return reply
      .header(
        "content-disposition",
        `attachment; filename="${source ? "sources" : j.skillName}.zip"`,
      )
      .type("application/zip")
      .send(await readFile(file));
  });
  app.get("/api/projects/:id/notes/:noteId/cover", async (req, reply) => {
    const pid = id(req),
      nid = z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .parse((req.params as any).noteId);
    const n = sdk.store.project(pid).notes.find((n) => n.id === nid);
    const file = n && coverFile(pid, n);
    if (!file) throw new TaskError("NOT_FOUND", "封面尚未缓存");
    return reply.type("image/jpeg").send(await readFile(file));
  });
  app.get("/api/projects/:id/notes/:noteId", async (req) => {
    const pid = id(req),
      nid = z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .parse((req.params as any).noteId);
    if (!sdk.store.project(pid).notes.some((n) => n.id === nid))
      throw new TaskError("NOT_FOUND", "笔记不存在");
    const dir = path.join(sdk.cfg.dataDir, "projects", pid, "notes", nid);
    const raw = await json<any>(path.join(dir, "raw.json")),
      analysis = await json<any>(path.join(dir, "analysis.json")),
      segments = await json<any>(path.join(dir, "segments.json"));
    return {
      body: raw?.body ?? null,
      analysis: analysis
        ? {
            ...analysis,
            clean: {
              ...analysis.clean,
              segments: analysis.clean.segments.map(
                ({ imagePath, ...s }: any) => s,
              ),
            },
          }
        : null,
      segments: segments?.segments?.map(({ imagePath, ...s }: any) => s) ?? [],
      media:
        raw?.media.map((m: any, i: number) => ({
          type: m.type,
          page: m.page,
          ready: !!m.path,
          index: i,
        })) ?? [],
    };
  });
  app.get(
    "/api/projects/:id/notes/:noteId/media/:index",
    async (req, reply) => {
      const pid = id(req),
        nid = z
          .string()
          .regex(/^[a-f0-9]{24}$/)
          .parse((req.params as any).noteId),
        index = z.coerce
          .number()
          .int()
          .min(0)
          .parse((req.params as any).index);
      const raw = await json<any>(
        path.join(sdk.cfg.dataDir, "projects", pid, "notes", nid, "raw.json"),
      );
      const m = raw?.media[index];
      if (!m?.path) throw new TaskError("NOT_FOUND", "媒体尚未获取");
      const file = path.resolve(m.path);
      const base =
        path.resolve(sdk.cfg.dataDir, "projects", pid, "notes", nid) + path.sep;
      if (!file.startsWith(base)) throw new TaskError("PATH", "媒体路径无效");
      const { createReadStream } = await import("node:fs");
      const size = (await stat(file)).size;
      reply
        .type(m.type === "video" ? "video/mp4" : "image/jpeg")
        .header("accept-ranges", "bytes");
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]),
          end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) return reply.code(416).send();
        return reply
          .code(206)
          .header("content-range", `bytes ${start}-${end}/${size}`)
          .header("content-length", end - start + 1)
          .send(createReadStream(file, { start, end }));
      }
      return reply.header("content-length", size).send(createReadStream(file));
    },
  );
  const web = path.resolve(root, "dist/web");
  if (existsSync(web)) {
    await app.register(fastifyStatic, { root: web, list: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  return { app, sdk };
}
