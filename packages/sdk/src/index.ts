import path from "node:path";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { Acquisition, downloadMedia, normalizeCard } from "./providers.ts";
import { CodexModel, type ModelRunner } from "./model.ts";
import { Cleaner, validateEvidence } from "./media.ts";
import { buildSkill, evaluateSkill, makeZip, installSkill, resolveMaterialIssues, type IssueResolution } from "./export.ts";
import {
  buildContextIndex,
  loadContextPackage,
  finalizeAttemptedOriginality,
  ContextRuntime,
  migrateLegacyJob,
  reconstructProvenance,
  synthesizeContext,
  JobInputBudget,
  DEFAULT_TOKEN_BUDGET,
  inputBudgetError,
  installContextSkill,
  annotateTemporality,
  TokenBudget,
  writeContextPackage,
} from "./context/index.ts";
import {
  assertSelection,
  atomic,
  hash,
  hashFile,
  json,
  parseLink,
  redact,
  run,
  safeName,
  TaskError,
} from "./util.ts";
import type { Config, Provider, Project, Job, Note, RawNote, CleanNote, Segment } from "./types.ts";
export * from "./types.ts";
export * from "./util.ts";
export * from "./context/index.ts";
export function config(
  root = process.cwd(),
  overrides: Partial<Config> = {},
): Config {
  const dataDir = path.resolve(
    process.env.XHS_DATA_DIR || path.join(root, "data"),
  );
  const homebrew = (name: string) =>
    existsSync("/opt/homebrew/bin/" + name)
      ? "/opt/homebrew/bin/" + name
      : name;
  return {
    dataDir,
    codexBin: process.env.CODEX_BIN || "codex",
    opencliBin: process.env.OPENCLI_BIN || "opencli",
    ffmpegBin: process.env.FFMPEG_BIN || homebrew("ffmpeg"),
    whisperBin: process.env.WHISPER_BIN || homebrew("whisper-cli"),
    whisperModel:
      process.env.WHISPER_MODEL ||
      path.join(dataDir, "models", "ggml-large-v3-turbo.bin"),
    visionBin:
      process.env.VISION_BIN || path.join(dataDir, "bin", "vision-ocr"),
    guaikeiEnabled: process.env.GUAIKEI_ENABLED === "true",
    requestIntervalMs: 3000,
    defaultLimit: 10,
    maxConcurrentNotes: Number(process.env.XHS_PROCESSING_CONCURRENCY || 2),
    contextBuildEnabled: process.env.XHS_CONTEXT_BUILD !== "false",
    ...overrides,
  };
}
export class Distiller {
  store: Store;
  acquisition: Acquisition;
  model: ModelRunner;
  cleaner: Cleaner;
  controllers = new Map<string, AbortController>();
  tasks = new Map<string, Promise<void>>();
  constructor(
    public cfg: Config,
    provider?: Provider,
    private desktopRunner?: ModelRunner,
  ) {
    this.store = new Store(cfg.dataDir);
    this.store.recover();
    this.acquisition = new Acquisition(cfg, provider);
    this.model = desktopRunner ?? new CodexModel(cfg, this.store);
    this.cleaner = new Cleaner(cfg, this.model);
  }
  createProject(
    name = "新的知识项目",
    skillName = "creator-advisor",
    limit = this.cfg.defaultLimit,
    purpose = "",
    tokenBudget = DEFAULT_TOKEN_BUDGET.hardLimit,
  ): Project {
    safeName(skillName);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TaskError("LIMIT", "上限必须为 1 至 100 的整数");
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 10_000 || tokenBudget > 20_000_000)
      throw new TaskError("TOKEN_BUDGET", "材料预算必须在 10,000 至 20,000,000 token 之间");
    const p: Project = {
      version: 1,
      id: randomUUID(),
      name,
      skillName,
      purpose,
      tokenBudget,
      limit,
      selected: [],
      createdAt: new Date().toISOString(),
      scan: { status: "pending", complete: false, count: 0 },
      notes: [],
    };
    this.store.put("project", p);
    return p;
  }
  updateProject(
    id: string,
    patch: Partial<
      Pick<Project, "name" | "skillName" | "purpose" | "limit" | "selected" | "tokenBudget">
    >,
  ) {
    return this.store.mutateProject(id, (p) => {
      const limit = patch.limit ?? p.limit,
        ids = patch.selected ?? p.selected;
      if (ids.length) assertSelection(ids, limit);
      else if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new TaskError("LIMIT", "上限必须为1至100");
      if (patch.skillName) safeName(patch.skillName);
      if (patch.tokenBudget !== undefined && (!Number.isSafeInteger(patch.tokenBudget) || patch.tokenBudget < 10_000 || patch.tokenBudget > 20_000_000))
        throw new TaskError("TOKEN_BUDGET", "材料预算必须在 10,000 至 20,000,000 token 之间");
      if (ids.some((id) => !p.notes.some((n) => n.id === id)))
        throw new TaskError("SELECTION", "选择了项目之外的笔记");
      Object.assign(p, patch);
    });
  }
  private upsert(id: string, n: Note) {
    this.store.mutateProject(id, (p) => {
      const index = p.notes.findIndex((x) => x.id === n.id);
      if (index >= 0)
        p.notes[index] = {
          ...p.notes[index],
          ...n,
          originalUrl: p.notes[index].originalUrl || p.notes[index].url,
        };
      else p.notes.push({ ...n, originalUrl: n.originalUrl || n.url });
      p.scan.count = p.notes.length;
    });
  }
  async close() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks.values()]);
    this.store.close();
  }
  async inspectEnvironment() {
    const checks = await Promise.allSettled([
      run(this.cfg.opencliBin, ["doctor"], { timeout: 20000 }),
      run(this.cfg.codexBin, ["login", "status"], { timeout: 10000 }),
      run(this.cfg.ffmpegBin, ["-version"], { timeout: 10000 }),
      run(this.cfg.whisperBin, ["--help"], { timeout: 10000 }),
      stat(this.cfg.whisperModel),
      stat(this.cfg.visionBin),
    ]);
    return ["browser", "codex", "ffmpeg", "whisper", "model", "ocr"]
      .map((name, i) => ({
        name,
        ready: checks[i].status === "fulfilled",
        message:
          checks[i].status === "rejected"
            ? redact((checks[i] as PromiseRejectedResult).reason.message)
            : name === "browser"
              ? "浏览器连接可用"
              : name === "codex"
                ? "已登录"
                : "已就绪",
      }))
      .concat([
        {
          name: "guaikei",
          ready: this.cfg.guaikeiEnabled && !!process.env.GUAIKEI_API_TOKEN,
          message: this.cfg.guaikeiEnabled ? "已启用可选接口" : "未启用，可选",
        },
      ]);
  }
  async importNoteLinks(projectId: string, input: string[]) {
    const seen = new Set<string>();
    for (const raw of input) {
      if (!raw.trim()) continue;
      const parsed = parseLink(raw);
      if (parsed.short) {
        const detail = await this.acquisition.detail(parsed.url);
        this.upsert(projectId, detail.note);
        await atomic(this.rawPath(projectId, detail.note.id), detail);
      } else if (!seen.has(parsed.id)) {
        seen.add(parsed.id);
        const p = this.store.project(projectId);
        if (!p.notes.some((n) => n.id === parsed.id))
          this.upsert(
            projectId,
            normalizeCard({ id: parsed.id, url: parsed.url }),
          );
        else {
          const n = p.notes.find((n) => n.id === parsed.id)!;
          n.url = parsed.url;
          this.upsert(projectId, n);
        }
      }
    }
    return this.store.project(projectId);
  }
  async listAuthorNotes(
    projectId: string,
    url: string,
    onUpdate?: (project: Project) => void,
  ) {
    parseLink(url, true);
    const key = "scan:" + projectId;
    if (this.controllers.has(key)) throw new TaskError("BUSY", "主页正在加载");
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    let p = this.store.project(projectId);
    p.scan = {
      ...p.scan,
      url,
      status: "running",
      complete: false,
      error: undefined,
    };
    (p.scan as any).ownerPid = process.pid;
    this.store.put("project", p);
    let hydrateDiscovered = false;
    const task = (async () => {
      try {
        const result = await this.acquisition.scan(
          url,
          (notes, complete) => {
            const p = this.store.mutateProject(projectId, (p) => {
              const merged = new Map(p.notes.map((n) => [n.id, n]));
              for (const n of notes) {
                const old = merged.get(n.id);
                if (!old) {
                  merged.set(n.id, n);
                  continue;
                }
                merged.set(n.id, {
                  ...n,
                  ...old,
                  url: n.url.includes("xsec_token=") ? n.url : old.url,
                  title: n.title || old.title,
                  cover: n.cover || old.cover,
                  likes: n.likes.value !== null ? n.likes : old.likes,
                  collects:
                    n.collects.value !== null ? n.collects : old.collects,
                  publishedAt: n.publishedAt || old.publishedAt,
                });
              }
              p.notes = [...merged.values()];
              p.scan.count = p.notes.length;
              p.scan.complete = complete;
            });
            onUpdate?.(p);
          },
          ctrl.signal,
        );
        p = this.store.project(projectId);
        p.scan.status = result.complete ? "complete" : "paused";
        p.scan.complete = result.complete;
        p.scan.error = result.reason;
        this.store.put("project", p);
        hydrateDiscovered = true;
      } catch (e: any) {
        p = this.store.project(projectId);
        p.scan.status = "paused";
        p.scan.error = redact(e.message);
        this.store.put("project", p);
      } finally {
        this.controllers.delete(key);
        this.tasks.delete(key);
        if (hydrateDiscovered && !ctrl.signal.aborted)
          void this.hydrate(projectId);
      }
    })();
    this.tasks.set(key, task);
    return { started: true };
  }
  cancelScan(id: string) {
    this.controllers.get("scan:" + id)?.abort();
    this.controllers.get("metadata:" + id)?.abort();
  }
  async hydrate(projectId: string, force = false) {
    const key = "metadata:" + projectId;
    if (this.controllers.has(key)) return;
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    const task = (async () => {
      try {
        for (const n of this.store.project(projectId).notes) {
          if (n.status === "complete" && !force) continue;
          try {
            const raw = await this.detailWithRefresh(projectId, n, ctrl.signal);
            const old = await json<RawNote>(this.rawPath(projectId, n.id));
            if (old)
              raw.media = raw.media.map((m) => {
                const cached = old.media.find(
                  (c) =>
                    c.type === m.type &&
                    c.url.split("?")[0] === m.url.split("?")[0],
                );
                return cached?.path
                  ? { ...m, path: cached.path, sha256: cached.sha256 }
                  : m;
              });
            this.upsert(projectId, raw.note);
            await atomic(this.rawPath(projectId, n.id), raw);
            if (raw.note.cover) {
              const cover = path.join(
                path.dirname(this.rawPath(projectId, n.id)),
                "cover.jpg",
              );
              try {
                if (!existsSync(cover))
                  await downloadMedia(
                    { type: "image", url: raw.note.cover },
                    cover,
                    ctrl.signal,
                    {
                      root: this.cfg.dataDir,
                      intervalMs: this.cfg.requestIntervalMs,
                    },
                  );
              } catch {
                /* Cover failure never turns known counts into missing metrics. */
              }
            }
          } catch (e: any) {
            this.upsert(projectId, {
              ...n,
              status: "failed",
              error: redact(e.message),
              collects: { ...n.collects, status: "failed" },
            });
            if (
              ctrl.signal.aborted ||
              ["AUTH_REQUIRED", "SECURITY_BLOCK", "BROWSER_CONNECT"].includes(
                e.code,
              )
            )
              break;
          }
        }
      } finally {
        this.controllers.delete(key);
        this.tasks.delete(key);
      }
    })();
    this.tasks.set(key, task);
  }
  private async detailWithRefresh(
    projectId: string,
    n: Note,
    signal?: AbortSignal,
  ): Promise<RawNote> {
    try {
      return await this.acquisition.detail(n.url, signal);
    } catch (error: any) {
      if (error.code !== "CONTENT_MISSING" || signal?.aborted) throw error;
      const profile = n.authorId
        ? `https://www.xiaohongshu.com/user/profile/${n.authorId}`
        : this.store.project(projectId).scan.url;
      if (!profile)
        throw new TaskError(
          "CONTENT_MISSING",
          "链接失效或内容不可访问，请更新分享链接",
        );
      let refreshed: Note | undefined;
      const found = new AbortController();
      try {
        await this.acquisition.scan(
          profile,
          (notes) => {
            refreshed =
              notes.find(
                (x) => x.id === n.id && x.url.includes("xsec_token="),
              ) ?? refreshed;
            if (refreshed) found.abort();
          },
          signal ? AbortSignal.any([signal, found.signal]) : found.signal,
        );
      } catch (e: any) {
        if (
          !refreshed ||
          signal?.aborted ||
          ["AUTH_REQUIRED", "SECURITY_BLOCK", "BROWSER_CONNECT"].includes(
            e.code,
          )
        )
          throw e;
      }
      if (!refreshed)
        throw new TaskError(
          "CONTENT_MISSING",
          "主页未找到可用链接，请更新该笔记分享链接",
        );
      this.upsert(projectId, {
        ...n,
        url: refreshed.url,
        originalUrl: n.originalUrl || n.url,
      });
      return this.acquisition.detail(refreshed.url, signal);
    }
  }
  private rawPath(pid: string, nid: string) {
    return path.join(
      this.cfg.dataDir,
      "projects",
      pid,
      "notes",
      nid,
      "raw.json",
    );
  }
  async fetchNote(projectId: string, noteId: string, signal?: AbortSignal) {
    const p = this.store.project(projectId),
      n = p.notes.find((n) => n.id === noteId);
    if (!n) throw new TaskError("NOT_FOUND", "笔记不存在");
    const file = this.rawPath(projectId, noteId),
      dir = path.dirname(file);
    let raw = await json<RawNote>(file);
    if (!raw) {
      raw = await this.detailWithRefresh(projectId, n, signal);
      await atomic(file, raw);
      this.upsert(projectId, raw.note);
    }
    if (raw.bodyStatus === "missing")
      throw new TaskError("CONTENT_MISSING", "正文提取状态缺失");
    let refreshedMedia = false;
    for (let i = 0; i < raw.media.length; i++) {
      const m = raw.media[i],
        ext = m.type === "video" ? ".mp4" : ".jpg";
      try {
        raw.media[i] = await downloadMedia(
          m,
          path.join(dir, "media", String(i + 1).padStart(3, "0") + ext),
          signal,
          { root: this.cfg.dataDir, intervalMs: this.cfg.requestIntervalMs },
        );
      } catch (e: any) {
        if (e.code !== "MEDIA_EXPIRED" || refreshedMedia || signal?.aborted)
          throw e;
        const fresh = await this.detailWithRefresh(projectId, n, signal);
        fresh.media = fresh.media.map((m) => {
          const cached = raw!.media.find(
            (c) =>
              c.type === m.type && c.url.split("?")[0] === m.url.split("?")[0],
          );
          return cached?.path
            ? { ...m, path: cached.path, sha256: cached.sha256 }
            : m;
        });
        await atomic(path.join(dir, "raw-before-media-refresh.json"), raw);
        raw = fresh;
        refreshedMedia = true;
        i = -1;
        this.upsert(projectId, raw.note);
      }
      await atomic(file, raw);
    }
    for (let index = 0; index < (raw.subtitles?.length || 0); index++) {
      const subtitle = raw.subtitles![index];
      if (subtitle.url && !subtitle.cues.length) {
        if (!/^https?:/.test(subtitle.url))
          throw new TaskError(
            "SUBTITLE",
            "字幕轨无法直接下载且浏览器未暴露文本",
          );
        const downloaded = await downloadMedia(
          {
            type: "image",
            url: subtitle.url,
            path: subtitle.path,
            sha256: subtitle.sha256,
          },
          path.join(dir, `subtitle-${index + 1}.vtt`),
          signal,
          { root: this.cfg.dataDir, intervalMs: this.cfg.requestIntervalMs },
        );
        subtitle.path = downloaded.path;
        subtitle.sha256 = downloaded.sha256;
        await atomic(file, raw);
      }
    }
    return raw;
  }
  async cleanNote(projectId: string, noteId: string, signal?: AbortSignal) {
    const raw = await this.fetchNote(projectId, noteId, signal);
    return this.cleaner.clean(
      raw,
      path.dirname(this.rawPath(projectId, noteId)),
      signal,
    );
  }
  startDistillation(projectId: string) {
    return this.store.transaction(() => {
      const job = this.createJob(projectId);
      this.launch(job.id);
      return job;
    });
  }
  prepareDesktopJob(projectId: string, selected: string[]) {
    return this.store.transaction(() => this.createJob(projectId, selected));
  }
  private createJob(projectId: string, desktopSelection?: string[]) {
    const p = this.store.project(projectId);
    const selected = desktopSelection ?? p.selected;
    assertSelection(selected, p.limit);
    if (selected.some(id => !p.notes.some(note => note.id === id)))
      throw new TaskError("SELECTION", "选择了项目之外的笔记");
    const id = randomUUID();
    if (
      this.store
        .list<Job>("job")
        .some((j) => j.projectId === projectId && j.status === "running")
    )
      throw new TaskError("BUSY", "当前项目已有任务运行");
    const now = new Date().toISOString();
    const j: Job = {
      version: 1,
      id,
      projectId,
      ...(desktopSelection ? { executor: "desktop" as const } : {}),
      status: "pending",
      stage: "获取原始内容",
      selected: [...selected],
      skillName: desktopSelection ? p.skillName.slice(0, 46) + "-" + id.slice(0, 8) : p.skillName,
      purpose: p.purpose,
      tokenBudget: p.tokenBudget ?? DEFAULT_TOKEN_BUDGET.hardLimit,
      noteStates: Object.fromEntries(
        selected.map((id) => [
          id,
          { fetch: "pending", clean: "pending", extract: "pending" },
        ]),
      ),
      createdAt: now,
      updatedAt: now,
    };
    this.store.put("job", j);
    if (j.tokenBudget !== DEFAULT_TOKEN_BUDGET.hardLimit) {
      const record = { id: j.id, used: 0, hardLimit: j.tokenBudget! };
      this.store.put("input-budget", record);
    }
    return j;
  }
  getJob(id: string) {
    const j = this.store.get<Job>("job", id);
    if (!j) throw new TaskError("NOT_FOUND", "任务不存在");
    const budget = new JobInputBudget(this.store, id).snapshot();
    j.tokenBudget = budget.hardLimit;
    j.budget = budget;
    if (j.error?.includes("token") || j.error?.includes("预算")) {
      const remainingNotes = j.selected.filter(noteId => j.noteStates[noteId]?.extract !== "complete");
      const completed = j.selected.length - remainingNotes.length;
      const perNote = completed ? Math.ceil(budget.used / completed) : 25_000;
      const titles = this.store.project(j.projectId).notes;
      j.budgetEstimate = { additional: Math.max(25_000, remainingNotes.length * Math.max(25_000, perNote) + 100_000 - budget.remaining), remainingNotes, remainingTitles: remainingNotes.map(noteId => titles.find(note => note.id === noteId)?.title || noteId), estimated: true };
    }
    return j;
  }
  raiseJobBudget(id: string, limit: number) {
    const j = this.getJob(id);
    if (j.status === "running") throw new TaskError("BUSY", "请先等待当前步骤暂停");
    const budget = new JobInputBudget(this.store, id).raiseLimit(limit);
    j.tokenBudget = budget.hardLimit;
    this.save(j);
    return this.getJob(id);
  }
  async finishPartialJob(id: string) {
    const j = this.getJob(id);
    if (j.status === "running") throw new TaskError("BUSY", "请先等待当前任务暂停");
    if (j.status === "complete") return j;
    const output = path.join(this.cfg.dataDir, "projects", j.projectId, "jobs", id);
    const sourceDir = path.join(output, "sources");
    await mkdir(sourceDir, { recursive: true });
    const analyses: any[] = [];
    for (const noteId of j.selected) {
      if (j.noteStates[noteId]?.extract !== "complete") continue;
      const analysis = await json<any>(path.join(path.dirname(this.rawPath(j.projectId, noteId)), "analysis.json"));
      if (analysis?.clean) analyses.push(analysis);
    }
    if (!analyses.length) throw new TaskError("INCOMPLETE", "尚无可用材料，无法生成草稿");
    for (const analysis of analyses) await atomic(path.join(sourceDir, analysis.clean.id + ".json"), analysis.clean);
    await atomic(path.join(output, "methods.json"), analyses.flatMap(item => item.methods ?? []));
    await atomic(path.join(output, "quality.json"), { complete: false, selected: j.selected, processed: analyses.map(item => item.clean.id), missing: j.selected.filter(noteId => !analyses.some(item => item.clean.id === noteId)) });
    const project = this.store.project(j.projectId);
    const version = "0.1.0";
    const directory = path.join(this.cfg.dataDir, "contexts", j.skillName, version);
    const pkg = await migrateLegacyJob({ dataDir: this.cfg.dataDir, projectId: j.projectId, jobId: j.id, contextId: j.skillName, version, name: project.name, purpose: project.purpose });
    pkg.manifest.status = "draft";
    pkg.manifest.description = `部分材料草稿：已处理 ${analyses.length}/${j.selected.length} 篇笔记。`;
    const budget = new JobInputBudget(this.store, j.id).snapshot();
    pkg.manifest.tokenBudget = { hardLimit: budget.hardLimit, degradedAt: Math.floor(budget.hardLimit * .8), used: budget.used, cumulativeUsed: budget.used };
    annotateTemporality(pkg);
    await writeContextPackage(pkg, directory);
    await buildContextIndex(directory);
    const runtime = new ContextRuntime(this.cfg.dataDir);
    await runtime.register(j.skillName, version);
    const installed = await installContextSkill(pkg.manifest, directory);
    await makeZip(path.join(directory, "skill", j.skillName), path.join(output, j.skillName + ".zip"));
    await makeZip(sourceDir, path.join(output, "sources.zip"));
    j.output = output;
    j.context = { contextId: j.skillName, version, status: "draft", processedClaims: 0, totalClaims: pkg.claims.length, unresolvedClaims: pkg.claims.length, tokenUsed: budget.used, skillName: installed.name, skillPath: installed.path };
    j.stage = "部分材料草稿";
    j.status = "paused";
    j.error = `已用 ${budget.used.toLocaleString()} / ${budget.hardLimit.toLocaleString()} token，已处理 ${analyses.length}/${j.selected.length} 篇；草稿已保存`;
    this.save(j);
    return this.getJob(id);
  }
  private save(j: Job) {
    j.updatedAt = new Date().toISOString();
    this.store.put("job", j);
  }
  private launch(id: string) {
    const ctrl = new AbortController();
    const j = this.getJob(id);
    const cancelFile = path.join(
      this.cfg.dataDir,
      "projects",
      j.projectId,
      "jobs",
      id,
      "cancel",
    );
    rmSync(cancelFile, { force: true });
    const timer = setInterval(() => {
      if (existsSync(cancelFile)) ctrl.abort();
    }, 500);
    this.controllers.set(id, ctrl);
    const execute = () => this.execute(id, ctrl.signal);
    const t = (this.desktopRunner ? execute() : this.model.within?.(id, execute) ?? execute()).finally(() => {
      clearInterval(timer);
      this.controllers.delete(id);
      this.tasks.delete(id);
    });
    this.tasks.set(id, t);
  }
  cancelJob(id: string) {
    const j = this.getJob(id);
    if (j.status === "complete") return j;
    this.controllers.get(id)?.abort();
    const dir = path.join(
      this.cfg.dataDir,
      "projects",
      j.projectId,
      "jobs",
      id,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "cancel"), "cancel");
    if (j.executor === "desktop" && j.status === "running") return j;
    j.status = "cancelled";
    this.save(j);
    return j;
  }
  resumeJob(id: string, options: { offline?: boolean } = {}) {
    return this.store.transaction(() => this.resumeStoredJob(id, options));
  }
  private resumeStoredJob(id: string, options: { offline?: boolean }) {
    if (this.controllers.has(id))
      throw new TaskError("BUSY", "任务仍在运行或正在停止");
    const j = this.getJob(id);
    if (j.status === "complete") return j;
    const inputBudget = new JobInputBudget(this.store, id);
    if (inputBudget.used() >= inputBudget.limit())
      throw inputBudgetError(inputBudget.limit());
    if ((j.executor === "desktop") !== !!this.desktopRunner)
      throw new TaskError("EXECUTOR", "请在原执行入口继续此任务");
    if (this.store.list<Job>("job").some(other =>
      other.id !== id && other.projectId === j.projectId && other.status === "running"))
      throw new TaskError("BUSY", "当前项目已有任务运行");
    if (j.status === "running" && j.ownerPid && j.ownerPid !== process.pid) {
      try {
        process.kill(j.ownerPid, 0);
        throw new TaskError("BUSY", "原任务进程仍在运行，请等待停止");
      } catch (e: any) {
        if (e.code === "BUSY" || e.code === "EPERM") throw e;
      }
    }
    (j as any).offline = options.offline === true;
    this.save(j);
    this.launch(id);
    return this.getJob(id);
  }
  async waitJob(id: string) {
    await this.tasks.get(id);
    return this.getJob(id);
  }
  private async buildContext(j: Job, signal: AbortSignal, materialBlocked = false) {
    const project = this.store.project(j.projectId);
    const version = "0.1.0";
    const directory = path.join(this.cfg.dataDir, "contexts", j.skillName, version);
    const workDir = path.join(this.cfg.dataDir, "context-builds", j.skillName, version, j.id);
    let pkg = await migrateLegacyJob({
      dataDir: this.cfg.dataDir,
      projectId: j.projectId,
      jobId: j.id,
      contextId: j.skillName,
      version,
      name: project.name,
      purpose: project.purpose,
    });
    const manifest = await json<typeof pkg.manifest>(path.join(directory, "manifest.json"));
    const durableBudget = new JobInputBudget(this.store, j.id);
    if (manifest?.sourceJobId === j.id) {
      durableBudget.seedLegacy(manifest.tokenBudget.cumulativeUsed ?? manifest.tokenBudget.used);
      if (manifest.stages.find(stage => stage.stage === "unitize")?.inputHash ===
            pkg.manifest.stages.find(stage => stage.stage === "unitize")?.inputHash &&
          manifest.stages.find(stage => stage.stage === "clean")?.inputHash ===
            pkg.manifest.stages.find(stage => stage.stage === "clean")?.inputHash) {
        pkg = await loadContextPackage(directory);
      }
    }
    if (j.executor === "desktop" && !pkg.manifest.capabilities.includes("agent-driven")) pkg.manifest.capabilities.push("agent-driven");
    await writeContextPackage(pkg, directory);
    pkg.manifest.tokenBudget.hardLimit = durableBudget.limit();
    pkg.manifest.tokenBudget.degradedAt = Math.floor(durableBudget.limit() * .8);
    const budget = new TokenBudget(pkg.manifest.tokenBudget.hardLimit, pkg.manifest.tokenBudget.degradedAt);
    const mark = (stage: any, status: any, tokens = 0) => {
      const record = pkg.manifest.stages.find((item) => item.stage === stage);
      if (!record) return;
      Object.assign(record, {
        status,
        inputTokens: tokens,
        attempts: record.attempts + 1,
        completedAt: status === "complete" ? new Date().toISOString() : undefined,
        outputHash: status === "complete" ? hash(JSON.stringify({ stage, counts: pkg.manifest.counts })) : null,
      });
    };
    j.stage = "自动查源与原创性判断";
    this.save(j);
    mark("discover", "running");
    const provenance = await reconstructProvenance(this.model, pkg, workDir, budget, signal, async (checkpoint, batch) => {
      checkpoint.manifest.description = `自动查源进行中，已完成 ${batch} 个批次。`;
      checkpoint.manifest.tokenBudget.cumulativeUsed = durableBudget.used();
      await writeContextPackage(checkpoint, directory);
    });
    signal.throwIfAborted();
    pkg = provenance.pkg;
    finalizeAttemptedOriginality(pkg.claims);
    const sourceStatus = provenance.complete ? "complete" : "paused";
    mark("discover", sourceStatus, budget.stageUsed("discover"));
    mark("verify", sourceStatus);
    mark("attribute", sourceStatus);
    j.stage = "综合 Thesis 与 Public Axioms";
    this.save(j);
    mark("synthesize", "running");
    ({ pkg } = await synthesizeContext(this.model, pkg, workDir, budget, signal));
    annotateTemporality(pkg);
    signal.throwIfAborted();
    mark("synthesize", "complete", budget.stageUsed("synthesize"));
    pkg.manifest.tokenBudget.used = durableBudget.used();
    pkg.manifest.tokenBudget.cumulativeUsed = durableBudget.used();
    const unresolved = pkg.claims.filter((claim) => claim.originality === "unresolved").length;
    pkg.manifest.status = !materialBlocked && provenance.complete && unresolved === 0 && pkg.theses.length > 0 && pkg.axioms.length > 0 ? "complete" : "draft";
    pkg.manifest.description = provenance.complete
      ? `已完成 ${pkg.claims.length} 项 Claim 的自动查源与 Context 综合。`
      : `已完成 ${provenance.traceAttemptedClaims}/${pkg.claims.length} 项 Claim 的自动查源；受单任务 token 安全上限约束，其余 Claim 保持待处理。`;
    pkg.manifest.capabilities = [...new Set([...pkg.manifest.capabilities, "source-provenance", "creator-contributions", "core-theses", "public-axioms", "mcp-runtime"])];
    j.stage = "索引与打包";
    this.save(j);
    mark("package", "complete");
    await writeContextPackage(pkg, directory);
    mark("index", "running");
    await buildContextIndex(directory);
    mark("index", "complete");
    mark("evaluate", "running");
    const runtime = new ContextRuntime(this.cfg.dataDir);
    const smokePacket = await runtime.buildContextPacket(j.skillName, pkg.claims[0]?.text || project.purpose || "核心方法", { version, maxChars: 12_000, limit: 5 });
    if (!smokePacket.evidence.length) throw new TaskError("CONTEXT_EVALUATION", "Context 检索未返回可引用证据");
    mark("evaluate", "complete");
    mark("register", "running");
    await runtime.register(j.skillName, version);
    const installedSkill = await installContextSkill(pkg.manifest, directory);
    mark("register", "complete");
    await writeContextPackage(pkg, directory);
    await buildContextIndex(directory);
    j.context = {
      contextId: j.skillName,
      version,
      status: pkg.manifest.status,
      processedClaims: provenance.traceAttemptedClaims,
      totalClaims: pkg.claims.length,
      unresolvedClaims: unresolved,
      tokenUsed: durableBudget.used(),
      skillName: installedSkill.name,
      skillPath: installedSkill.path,
    };
    this.save(j);
    return pkg;
  }
  private async execute(id: string, signal: AbortSignal) {
    const j = this.getJob(id);
    j.status = "running";
    j.ownerPid = process.pid;
    j.error = undefined;
    this.save(j);
    const output = path.join(
      this.cfg.dataDir,
      "projects",
      j.projectId,
      "jobs",
      id,
    );
    await mkdir(output, { recursive: true });
    j.output = output;
    this.save(j);
    try {
      let sourceBlocked = (j as any).offline === true;
      for (const nid of j.selected) {
        signal.throwIfAborted();
        const state = j.noteStates[nid];
        j.stage = "获取原始内容";
        state.error = undefined;
        this.save(j);
        try {
          const raw = await json<RawNote>(this.rawPath(j.projectId, nid));
          if (sourceBlocked && (!raw || raw.media.some((m) => !m.path)))
            throw new TaskError(
              "SOURCE_PAUSED",
              "数据来源已暂停，等待恢复访问",
            );
          state.fetch = "running";
          this.save(j);
          if ((j as any).offline) {
            if (!raw || raw.bodyStatus !== "ready")
              throw new TaskError("CHECKPOINT", "本地正文缺失");
            for (const media of raw.media) {
              if (
                !media.path ||
                !media.sha256 ||
                (await hashFile(media.path)) !== media.sha256
              )
                throw new TaskError(
                  "CHECKPOINT",
                  "本地媒体缺失或校验失败，需要联网恢复",
                );
            }
          } else await this.fetchNote(j.projectId, nid, signal);
          state.fetch = "complete";
        } catch (e: any) {
          state.fetch = "failed";
          state.clean = "pending";
          state.extract = "pending";
          state.error = redact(e.message);
          if (signal.aborted) throw e;
          if (
            ["AUTH_REQUIRED", "SECURITY_BLOCK", "BROWSER_CONNECT"].includes(
              e.code,
            )
          )
            sourceBlocked = true;
        }
        this.save(j);
      }
      j.stage = "提取与清洗";
      const queue = j.selected.filter(
        (nid) => j.noteStates[nid].fetch === "complete",
      );
      let fatal: any;
      const processing = new AbortController();
      const processingSignal = AbortSignal.any([signal, processing.signal]);
      const worker = async () => {
        while (queue.length && !fatal && !signal.aborted) {
          const nid = queue.shift()!,
            state = j.noteStates[nid];
          try {
            state.clean = "running";
            this.save(j);
            const raw = await json<RawNote>(this.rawPath(j.projectId, nid));
            if (!raw) throw new TaskError("CHECKPOINT", "本地笔记检查点缺失");
            await this.cleaner.clean(
              raw,
              path.dirname(this.rawPath(j.projectId, nid)),
              processingSignal,
              (message) => {
                state.detail = message;
                this.save(j);
              },
            );
            state.clean = "complete";
            state.extract = "complete";
            state.detail = undefined;
            state.error = undefined;
          } catch (e: any) {
            state.clean = "failed";
            state.extract = "pending";
            state.error = redact(e.message);
            if (signal.aborted || ["QUOTA", "TOKEN_BUDGET"].includes(e.code)) {
              fatal ||= e;
              processing.abort();
            }
          }
          this.save(j);
        }
      };
      const concurrency = Number.isFinite(this.cfg.maxConcurrentNotes)
        ? Math.max(1, Math.min(4, Math.floor(this.cfg.maxConcurrentNotes)))
        : 1;
      await Promise.all(Array.from({ length: concurrency }, worker));
      signal.throwIfAborted();
      if (fatal) throw fatal;
      j.stage = "提取 Claim";
      this.save(j);
      const failed = j.selected.filter(
        (nid) => j.noteStates[nid].extract !== "complete",
      );
      const analyses = [];
      for (const nid of j.selected.filter(
        (nid) => j.noteStates[nid].extract === "complete",
      )) {
        const a = await json<any>(
          path.join(
            path.dirname(this.rawPath(j.projectId, nid)),
            "analysis.json",
          ),
        );
        if (!a) throw new TaskError("CHECKPOINT", "分析检查点缺失");
        analyses.push(a);
      }
      if (!analyses.length)
        throw new TaskError(
          "INCOMPLETE",
          "尚无可用清洗材料；请修复访问或依赖后恢复",
        );
      validateEvidence(
        analyses.flatMap((a) => a.methods),
        analyses.map((a) => a.clean),
      );
      if (j.executor === "desktop") {
        if (failed.length)
          throw new TaskError("INCOMPLETE", `${failed.length} 篇笔记尚未完成，可修复后继续`);
        // The Context migration consumes the same clean-note and method format as legacy jobs.
        await mkdir(path.join(output, "sources"), { recursive: true });
        const methods = analyses.flatMap(a => a.methods);
        if (!methods.length)
          throw new TaskError("NO_METHODS", "材料中尚未提取到有依据的方法");
        await atomic(path.join(output, "methods.json"), methods);
        const unresolved = [];
        const resolved = [];
        for (const analysis of analyses) {
          const clean: CleanNote = analysis.clean;
          const review = await json<{ resolutions?: IssueResolution[] }>(
            path.join(path.dirname(this.rawPath(j.projectId, clean.id)), "quality-resolutions.json"),
          );
          const issues = resolveMaterialIssues(clean.id, clean.issues, review?.resolutions ?? []);
          unresolved.push(...issues.unresolved);
          resolved.push(...issues.resolved);
          const supplements: Segment[] = [];
          for (const issue of issues.resolved) {
            const resolution = issue.resolution;
            if (!resolution?.supplementTime || !resolution.supplement?.trim()) continue;
            supplements.push({
              id: `${issue.location}-review-${hash(issue.message).slice(0, 8)}`,
              kind: "audio",
              text: resolution.supplement.trim(),
              ...resolution.supplementTime,
            });
          }
          await atomic(path.join(output, "sources", clean.id + ".json"), {
            ...clean, segments: [...clean.segments, ...supplements],
          });
        }
        await atomic(path.join(output, "quality.json"), {
          selected: j.selected, processed: analyses.map(a => a.clean.id), methods: methods.length,
          criticalIssues: unresolved, resolvedIssues: resolved,
        });
        const context = await this.buildContext(j, signal, unresolved.length > 0);
        j.status = context.manifest.status === "complete" ? "complete" : "paused";
        j.stage = j.status === "complete" ? "已完成" : "Context 草稿待完善";
        if (unresolved.length) j.error = `存在 ${unresolved.length} 处关键材料疑点，Context 保留为草稿`;
        else if (j.status === "paused") j.error = "查源或综合仍有未完成项，Context 保留为草稿";
        this.save(j);
        return;
      }
      j.stage = "生成兼容 Skill";
      this.save(j);
      const built = await buildSkill(
        this.model,
        this.store.project(j.projectId),
        j,
        analyses,
        output,
        signal,
      );
      j.stage = "验证兼容入口";
      this.save(j);
      const evaluation = failed.length
        ? { cases: [], issues: ["部分材料缺失，完整行为验收暂未运行"] }
        : await evaluateSkill(
            this.model,
            built.skill,
            built.methods,
            j.purpose,
            output,
            signal,
          );
      const passed =
        failed.length === 0 &&
        evaluation.cases?.length === 8 &&
        evaluation.cases.every((c: any) => c.passed) &&
        built.critical.length === 0;
      const report = {
        version: 1,
        complete: passed,
        missing: failed,
        selected: j.selected,
        processed: analyses.map((a) => a.clean.id),
        methods: built.methods.length,
        criticalIssues: built.critical,
        resolvedIssues: built.resolved,
        materialIssues: built.materialIssues,
        behavioralEvaluation: evaluation,
        limitations: [
          "行为测试由模型执行和评审，不能证明与作者本人判断完全相同",
          "公开材料仅覆盖用户精选范围",
        ],
        createdAt: new Date().toISOString(),
      };
      await atomic(path.join(output, "quality.json"), report);
      const qualityText = `# 质量报告\n\n状态：${passed ? "通过自动检查" : "草稿：需要核查"}\n\n材料：${analyses.length}/${j.selected.length}\n方法：${built.methods.length}\n\n## 尚未完成的材料\n\n${failed.length ? failed.map((nid) => `- ${nid}：${j.noteStates[nid].error || "尚未完成"}`).join("\n") : "无"}\n\n## 阻断性材料疑点\n\n${built.critical.map((i) => `- ${i.noteId} · ${i.location}：${i.message}`).join("\n") || "无阻断性疑点"}\n\n## 已复核材料疑点\n\n${built.resolved.map((i) => `- ${i.noteId} · ${i.location}：${i.message}\n  - 处理：${i.resolution?.reason}\n  - 证据：${i.resolution?.evidence.join("；")}`).join("\n") || "无"}\n\n## 行为检查\n\n${evaluation.cases.map((c: any) => `- ${c.name}：${c.passed ? "通过" : "未通过"} — ${c.reason}`).join("\n") || "材料尚未齐全，完整行为验收未运行"}\n\n${report.limitations.join("\n\n")}`;
      await atomic(path.join(output, "quality.md"), qualityText);
      await atomic(path.join(output, "sources", "quality.md"), qualityText);
      await atomic(path.join(output, "sources", "quality.json"), report);
      await atomic(path.join(output, "sources", "methods.json"), built.methods);
      const project = this.store.project(j.projectId);
      await atomic(path.join(output, "sources", "manifest.json"), {
        version: 1,
        skillName: j.skillName,
        notes: j.selected.map((nid) => {
          const note = project.notes.find((n) => n.id === nid)!;
          return {
            id: nid,
            title: note.title || null,
            author: note.author || null,
            url: `https://www.xiaohongshu.com/explore/${nid}`,
            type: note.type,
            fetchedAt: note.fetchedAt || null,
            status: j.noteStates[nid],
            source: note.source,
            likes: note.likes,
            collects: note.collects,
          };
        }),
      });
      await atomic(
        path.join(built.skill, "references", "quality.md"),
        qualityText,
      );
      await makeZip(built.skill, path.join(output, j.skillName + ".zip"));
      await makeZip(
        path.join(output, "sources"),
        path.join(output, "sources.zip"),
      );
      let contextComplete = true;
      if (this.cfg.contextBuildEnabled) {
        const context = await this.buildContext(j, signal);
        contextComplete = context.manifest.status === "complete";
      }
      j.status = passed && contextComplete ? "complete" : "paused";
      j.stage = passed && contextComplete ? "已完成" : "Context 草稿待完善";
      if (!passed)
        j.error = failed.length
          ? `已生成草稿，${failed.length} 篇尚未完成；请恢复访问后继续`
          : "已生成草稿；关键疑点或行为测试未通过，请查看质量报告";
      else if (!contextComplete)
        j.error = `Context 已生成草稿；自动查源完成 ${j.context?.processedClaims ?? 0}/${j.context?.totalClaims ?? 0} 项 Claim，未宣称完整完成`;
      this.save(j);
    } catch (e: any) {
      j.status = signal.aborted && j.executor !== "desktop" ? "cancelled" : "paused";
      if (e.code === "TOKEN_BUDGET") j.stage = "预算已用完";
      j.error = signal.aborted && j.executor === "desktop"
        ? "已暂停，已接受的检查点可以继续"
        : redact(e.message);
      this.save(j);
      await atomic(path.join(output, "status.json"), {
        status: j.status,
        error: j.error,
        selected: j.selected,
        noteStates: j.noteStates,
      });
    }
  }
  async exportBundle(id: string) {
    const j = this.getJob(id);
    if (!j.output) throw new TaskError("NOT_READY", "尚未生成产物");
    const file = path.join(j.output, j.skillName + ".zip");
    await stat(file);
    return file;
  }
  async install(id: string) {
    const j = this.getJob(id);
    if (j.context) {
      const pkg = await loadContextPackage(path.join(this.cfg.dataDir, "contexts", j.context.contextId, j.context.version));
      return (await installContextSkill(pkg.manifest, path.join(this.cfg.dataDir, "contexts", j.context.contextId, j.context.version))).path;
    }
    if (j.status !== "complete")
      throw new TaskError("NOT_READY", "只有通过检查的skill可以安装");
    return installSkill(
      path.join(j.output!, "skill", j.skillName),
      j.skillName,
    );
  }
}
