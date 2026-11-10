import React, { useEffect, useState, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type {
  Project,
  Note,
  Job,
  Metric,
} from "../../../packages/sdk/src/types";
import "./style.css";
import { AttributionPanel } from "./attribution";
import { friendlyFailure, jobStages, noteProgress, setupStatus, stageTimingLabels } from "./copy";
async function api<T = any>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api" + url, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("连不上本地工作台。请确认 Cluefolio 已启动，再刷新页面。"); });
  const x = await r.json().catch(() => null);
  if (!r.ok || x === null) throw new Error(friendlyFailure(x?.error, x?.code));
  return x;
}
const statusName: Record<string, string> = {
  pending: "待开始",
  running: "处理中",
  paused: "已暂停",
  failed: "处理失败",
  complete: "已完成",
  cancelled: "已取消",
};
const typeName: Record<string, string> = {
  unknown: "类型待确认",
  text: "文字",
  image: "图文",
  video: "视频",
};
function count(m: Metric) {
  return m.status === "failed"
    ? "读取失败"
    : m.value === null
      ? "待读取"
      : (m.approximate ? "约 " : "") + (m.raw || String(m.value));
}
function sourceDate(value: string | null | undefined) {
  if (!value) return "日期未确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
const pages = {
  context: { title: "按问题找原文", description: "收藏时觉得有用，工作时想不起在哪？在这里找回可复用的原则、适用条件、上游来源和博主自己的解释。" },
  library: { title: "笔记库", description: "导入小红书笔记，勾选想整理的内容。" },
  tasks: { title: "任务进度", description: "查看每篇笔记的处理进度，或继续未完成的任务。" },
  results: { title: "处理结果", description: "查看整理出的内容、原始来源和检查结果。" },
  settings: { title: "项目设置", description: "修改这个项目的名称、用途和笔记选择上限。" },
  new: { title: "新建项目", description: "按博主或主题建一个项目，集中保存笔记和整理结果。" },
};
type Page = keyof typeof pages;
const standaloneScope = "standalone";
const scopeStorageKey = "cluefolio.project-by-page";
function readProjectScopes(): Partial<Record<Page, string>> {
  try {
    const saved = JSON.parse(localStorage.getItem(scopeStorageKey) ?? "{}");
    return Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
      Object.hasOwn(pages, key) && typeof value === "string"));
  } catch { return {}; }
}
function readPage(): Page {
  const page = window.location.hash.slice(1);
  return Object.hasOwn(pages, page) ? page as Page : "context";
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectByPage, setProjectByPage] = useState<Partial<Record<Page, string>>>(readProjectScopes),
    [jobs, setJobs] = useState<Job[]>([]),
    [tab, setTab] = useState<Page>(readPage),
    [returnPage, setReturnPage] = useState<Page>("context"),
    [loaded, setLoaded] = useState(false),
    [mode, setMode] = useState("links"),
    [links, setLinks] = useState(""),
    [profile, setProfile] = useState(""),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [sort, setSort] = useState("date"),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [env, setEnv] = useState<any[] | null>(null),
    [result, setResult] = useState<any>(null),
    [resultJobId, setResultJobId] = useState(""),
    [viewed, setViewed] = useState<Note | null>(null),
    [focusSegment, setFocusSegment] = useState<string | null>(null),
    [focusTime, setFocusTime] = useState<number | undefined>(),
    [focusPage, setFocusPage] = useState<number | undefined>(),
    [viewedProject, setViewedProject] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [newName, setNewName] = useState(""),
    [contexts, setContexts] = useState<any[]>([]),
    [contextByProject, setContextByProject] = useState<Record<string, string>>({}),
    [contextOverview, setContextOverview] = useState<any>(null),
    [contextQuery, setContextQuery] = useState(""),
    [contextQuality, setContextQuality] = useState<any>(null),
    [focusClaim, setFocusClaim] = useState<{ id: string } | null>(null),
    [contextPacket, setContextPacket] = useState<any>(null);
  const defaultProject = tab === "context"
    ? projects.find(project => contexts.some(item => item.sourceProjectId === project.id && item.status === "complete")) ?? projects[0]
    : projects[0];
  const standaloneContexts = contexts.filter(item => !projects.some(project => project.id === item.sourceProjectId));
  const standalone = tab === "context" && standaloneContexts.length > 0 &&
    (projectByPage.context === standaloneScope || !projects.length);
  const p = standalone ? undefined : projects.find(project => project.id === projectByPage[tab]) ?? defaultProject;
  const pid = standalone ? standaloneScope : p?.id ?? "";
  const projectContexts = standalone ? standaloneContexts : contexts.filter(item => item.sourceProjectId === pid);
  const selectedContext = projectContexts.find(item => item.contextId === contextByProject[pid])
    ?? projectContexts.find(item => item.status === "complete") ?? projectContexts[0];
  const contextId = selectedContext?.contextId ?? "";
  const contextVersion = selectedContext?.version ?? "0.1.0";
  const overview = contextOverview?.manifest.contextId === contextId &&
    contextOverview?.manifest.version === contextVersion ? contextOverview : null;
  const loadAttribution = useCallback(() => api(`/contexts/${contextId}/attribution?version=${contextVersion}`), [contextId, contextVersion, selectedContext?.updatedAt]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentJobs = jobs.filter((j) => j.projectId === pid);
  const job = currentJobs.find((j) => j.id === resultJobId) ?? currentJobs[0];

  function navigate(page: Page, projectId?: string) {
    if (projectId) setProjectByPage(previous => ({ ...previous, [page]: projectId }));
    if (page === "new" && tab !== "new") setReturnPage(tab);
    if (page !== tab) {
      setError("");
      setNotice("");
      setTab(page);
    }
    if (window.location.hash !== `#${page}`) window.location.hash = page;
  }

  function changeProject(projectId: string) {
    setProjectByPage(previous => ({ ...previous, [tab]: projectId }));
    setError("");
    setNotice("");
    setEnv(null);
    setLinks("");
    setProfile("");
    setQuery("");
    setKind("all");
    setResult(null);
    setResultJobId("");
  }

  const refresh = async () => {
    const [ps, js, cs] = await Promise.all([
      api<Project[]>("/projects"),
      api<Job[]>("/jobs"),
      api<any[]>("/contexts"),
    ]);
    setProjects(ps);
    setJobs(js);
    setContexts(cs);
    setLoaded(true);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const t = setInterval(() => void refresh().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(scopeStorageKey, JSON.stringify(projectByPage)); }
    catch { /* Selection is still available for this visit. */ }
  }, [projectByPage]);
  useEffect(() => {
    const syncPage = () => setTab(readPage());
    window.addEventListener("hashchange", syncPage);
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => {
    if (tab !== "results" || !job) return;
    let current = true;
    setResult(null);
    void api("/jobs/" + job.id + "/result")
      .then(value => { if (current) setResult(value); })
      .catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [tab, job?.id, job?.updatedAt]);
  useEffect(() => {
    setPage(1);
  }, [query, kind, sort, pid]);
  useEffect(() => {
    setContextPacket(null);
    setContextQuality(null);
    setFocusClaim(null);
  }, [contextId, contextVersion]);
  useEffect(() => {
    if (tab !== "context" || !contextId) return;
    let current = true;
    void api(`/contexts/${contextId}/overview?version=${contextVersion}`)
      .then(value => { if (current) setContextOverview(value); })
      .catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [tab, contextId, contextVersion, selectedContext?.updatedAt]);
  useEffect(() => {
    if (!viewed) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewed(null);
      if (e.key === "Tab") {
        const dialog = document.querySelector("[role=dialog]");
        const items = Array.from(
          dialog?.querySelectorAll<HTMLElement>(
            "button, a, input, textarea, select, video",
          ) ?? [],
        ).filter((el) => !el.hasAttribute("disabled"));
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [viewed]);
  function seekEvidence() {
    const segment = detail?.segments?.find((s: any) => s.id === focusSegment);
    const start = focusTime ?? segment?.start;
    if (videoRef.current && start !== undefined)
      videoRef.current.currentTime = start;
  }
  useEffect(() => {
    if (!detail) return;
    const target = (focusPage && document.getElementById("media-page-" + focusPage)) ||
      (focusSegment && document.getElementById("source-" + focusSegment));
    if (target) target.scrollIntoView({ block: "center" });
    if (videoRef.current?.readyState) seekEvidence();
  }, [detail, focusSegment, focusTime, focusPage]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: unknown) => api("/projects/" + pid, "PATCH", patch);
  const select = (n: Note) =>
    action(async () => {
      if (!p) return;
      const chosen = p.selected.includes(n.id);
      if (!chosen && p.selected.length >= p.limit)
        throw new Error(`已选满 ${p.limit} 篇。可以取消部分勾选，或在项目设置提高上限。`);
      await update({
        selected: chosen
          ? p.selected.filter((id) => id !== n.id)
          : [...p.selected, n.id],
      });
    });
  let notes = (p?.notes ?? []).filter(
    (n) =>
      (!query ||
        n.title.toLowerCase().includes(query.toLowerCase()) ||
        n.id.includes(query)) &&
      (kind === "all" || n.type === kind),
  );
  notes = [...notes].sort((a, b) =>
    sort === "likes"
      ? (b.likes.value ?? -1) - (a.likes.value ?? -1)
      : sort === "collects"
        ? (b.collects.value ?? -1) - (a.collects.value ?? -1)
        : String(b.publishedAt ?? "").localeCompare(
            String(a.publishedAt ?? ""),
          ),
  );
  const totalPages = Math.max(1, Math.ceil(notes.length / 20)),
    actualPage = Math.min(page, totalPages),
    visible = notes.slice((actualPage - 1) * 20, actualPage * 20);
  async function openNote(n: Note, segmentId?: string, projectId = pid, start?: number, page?: number) {
    setViewedProject(projectId);
    setFocusTime(start);
    setFocusPage(page);
    setFocusSegment(segmentId || null);
    setViewed(n);
    setDetail(null);
    try {
      setDetail(await api(`/projects/${projectId}/notes/${n.id}`));
    } catch (e: any) {
      setViewed(null);
      setError(e.message);
    }
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Cluefolio 首页">
          <span>
            Cluefolio<small>Context 淘金盆</small>
          </span>
        </a>
        <nav aria-label="工作台导航">
          {([
            ["context", "问", "查资料"],
            ["library", "录", "笔记库"],
            ["tasks", "进", "任务进度"],
            ["results", "阅", "处理结果"],
            ["settings", "设", "项目设置"],
          ] as const).map(([key, icon, label]) => (
            <button key={key} className={tab === key ? "nav active" : "nav"}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => navigate(key)}>
              <span aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-dot" /> 保存在这台 Mac
          <p>
            笔记和处理结果保存在本机。
            <br />
            Cluefolio 用你的 Codex 账号整理笔记。
          </p>
          <button
            className="text-button"
            onClick={() =>
              action(async () => setEnv(await api("/environment")))
            }
          >
            检查连接和工具
          </button>
        </div>
      </aside>
      <main>
        <div className={`workspace ${tab === "context" ? "search-workspace" : ""}`}>
          {tab !== "context" && <header className="page-heading">
            <div><h1>{pages[tab].title}</h1><p>{pages[tab].description}</p></div>
          </header>}
          {tab !== "context" && tab !== "new" && (
            <div className="project-scope">
              <label htmlFor="section-project">当前项目
                <select id="section-project" value={pid} disabled={!projects.length || busy} onChange={event => changeProject(event.target.value)}>
                  {!projects.length && <option value="">还没有项目</option>}
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              {p && <p>{p.notes.length ? `${p.notes.length} 篇笔记` : "新项目，还没有笔记"}{tab === "tasks" && ` · ${currentJobs.length} 个任务`}</p>}
              <button className="secondary" onClick={() => navigate("new")}>新建项目</button>
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              {notice}
            </div>
          )}
          {env && (
            <section className="environment">
              <div className="section-head">
                <h2>连接和工具</h2>
                <button className="text-button" onClick={() => setEnv(null)}>
                  收起
                </button>
              </div>
              <div className="env-grid">
                {env.map((e) => (
                  <div key={e.name}>
                    <span className={e.ready ? "dot ready" : "dot"} />
                    <strong>
                      {{
                        browser: "浏览器",
                        codex: "Codex",
                        ffmpeg: "音视频工具",
                        whisper: "语音识别",
                        model: "语音模型",
                        ocr: "文字识别",
                        guaikei: "备用笔记来源",
                      }[e.name as string] ?? e.name}
                    </strong>
                    <small>{setupStatus(e.name, e.ready)}</small>
                  </div>
                ))}
              </div>
            </section>
          )}
          {tab === "library" && (
            <>
              <section className="import-area">
                <div className="switch" role="tablist" aria-label="导入方式">
                  <button
                    role="tab"
                    aria-selected={mode === "links"}
                    className={mode === "links" ? "chosen" : ""}
                    onClick={() => setMode("links")}
                  >
                    笔记链接
                  </button>
                  <button
                    role="tab"
                    aria-selected={mode === "profile"}
                    className={mode === "profile" ? "chosen" : ""}
                    onClick={() => setMode("profile")}
                  >
                    博主主页
                  </button>
                </div>
                <div className="import-row">
                  {mode === "links" ? (
                    <textarea
                      aria-label="笔记链接"
                      rows={2}
                      placeholder="粘贴小红书笔记链接，每行一条。"
                      value={links}
                      onChange={(e) => setLinks(e.target.value)}
                    />
                  ) : (
                    <input
                      aria-label="博主主页链接"
                      placeholder="粘贴小红书博主主页链接"
                      value={profile}
                      onChange={(e) => setProfile(e.target.value)}
                    />
                  )}
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !p ||
                      !(mode === "links" ? links.trim() : profile.trim())
                    }
                    onClick={() =>
                      action(async () => {
                        if (mode === "links") {
                          const found =
                            links.match(/https?:\/\/[^\s<>"\])]+/g) || [];
                          if (!found.length) throw new Error("没找到可导入的链接。请粘贴小红书的完整分享链接。");
                          await api("/projects/" + pid + "/import", "POST", {
                            links: found,
                          });
                          setLinks("");
                          setNotice("笔记链接已添加。可以在下方勾选想整理的笔记。");
                        } else
                          await api("/projects/" + pid + "/scan", "POST", {
                            url: profile,
                          });
                      })
                    }
                  >
                    {busy
                      ? "处理中…"
                      : mode === "links"
                        ? "导入笔记"
                        : "加载主页笔记"}
                    <span aria-hidden="true"> ↗</span>
                  </button>
                </div>
                <div className="import-foot">
                  <span>
                    {!p ? "先新建项目，再导入笔记。" : mode === "links"
                      ? "重复链接只导入一次。已选笔记会保留。"
                      : "先显示公开笔记，再补上能读取的收藏数。"}
                  </span>
                  {p?.scan.url && (
                    <span className="scan-status">
                      {p.scan.status === "running"
                        ? "正在加载"
                        : p.scan.complete
                          ? "主页笔记已加载完"
                          : "主页笔记未加载完"}{" "}
                      · {p.scan.count} 篇{" "}
                      <button
                        className="text-button"
                        onClick={() =>
                          action(() =>
                            p.scan.status === "running"
                              ? api(
                                  "/projects/" + pid + "/stop-scan",
                                  "POST",
                                  {},
                                )
                              : api("/projects/" + pid + "/scan", "POST", {
                                  url: p.scan.url,
                                }),
                          )
                        }
                      >
                        {p.scan.status === "running" ? "暂停加载" : p.scan.complete ? "重新加载" : "继续加载"}
                      </button>
                    </span>
                  )}
                </div>
                {p?.scan.error && <p className="warning">{friendlyFailure(p.scan.error, undefined, "主页还没读完。可以继续加载，已找到的笔记会保留。")}</p>}
              </section>
              <div className="library-toolbar">
                <div>
                  <h2>
                    笔记列表 <span>{p?.notes.length ?? 0}</span>
                  </h2>
                  <p className="subtle">{p?.selected.length ?? 0} 篇已选</p>
                </div>
                <div className="filters">
                  <input
                    aria-label="搜索笔记"
                    placeholder="按笔记标题搜索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <select
                    aria-label="笔记类型"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="all">全部类型</option>
                    <option value="video">视频</option>
                    <option value="image">图文</option>
                    <option value="text">文字</option>
                    <option value="unknown">类型待确认</option>
                  </select>
                  <select
                    aria-label="排序方式"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="date">最新发布</option>
                    <option value="likes">点赞最多</option>
                    <option value="collects">收藏最多</option>
                  </select>
                  <button
                    className="text-button"
                    disabled={busy || !p}
                    onClick={() =>
                      action(() =>
                        api("/projects/" + pid + "/hydrate", "POST", {}),
                      )
                    }
                  >
                    读取缺失信息
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || !p}
                    onClick={() =>
                      action(() =>
                        api("/projects/" + pid + "/hydrate", "POST", {
                          force: true,
                        }),
                      )
                    }
                  >
                    刷新点赞和收藏
                  </button>
                </div>
              </div>
              {!p?.notes.length ? (
                <div className="empty">
                  <div className="empty-glyph">▱</div>
                  <h2>这里还没有笔记</h2>
                  <p>
                    粘贴笔记链接，或打开博主主页加载笔记。
                    <br />
                    每次默认可选 10 篇，数量可在项目设置中修改。
                  </p>
                </div>
              ) : !visible.length ? (
                <div className="empty">
                  <h2>没有匹配的笔记</h2>
                  <button
                    onClick={() => {
                      setQuery("");
                      setKind("all");
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className="note-grid">
                  {visible.map((n, index) => (
                    <article
                      key={n.id}
                      className={
                        "note-card" +
                        (p.selected.includes(n.id) ? " selected" : "")
                      }
                    >
                      <div className="cover">
                        <button
                          className="cover-button"
                          aria-label={"查看 " + (n.title || n.id)}
                          onClick={() => void openNote(n)}
                        >
                          {n.cover ? (
                            <img
                              src={n.cover}
                              alt={n.title || "笔记封面"}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="cover-placeholder">
                              <span>{n.status === "failed" ? "!" : "▱"}</span>
                              <small>
                                {n.status === "failed"
                                  ? "封面读取失败"
                                  : "封面尚未读取"}
                              </small>
                            </div>
                          )}
                        </button>
                        <label className="select-box">
                          <input
                            type="checkbox"
                            aria-label={"选择 " + (n.title || n.id)}
                            checked={p.selected.includes(n.id)}
                            disabled={
                              busy ||
                              (!p.selected.includes(n.id) &&
                                p.selected.length >= p.limit)
                            }
                            onChange={() => void select(n)}
                          />
                        </label>
                        <span className="type-label">
                          {n.type === "video" ? "▶ " : ""}
                          {typeName[n.type]}
                        </span>
                      </div>
                      <div className="note-info">
                        <button
                          className="note-title"
                          onClick={() => void openNote(n)}
                        >
                          {n.title || "标题尚未读取"}
                        </button>
                        <p className="note-author">
                          {n.author || "作者未知"}
                          {n.publishedAt && (
                            <time>
                              {new Date(n.publishedAt).toLocaleDateString(
                                "zh-CN",
                                {
                                  year: "numeric",
                                  month: "numeric",
                                  day: "numeric",
                                },
                              )}
                            </time>
                          )}
                        </p>
                        <div className="metrics">
                          <span title="点赞量">♡ {count(n.likes)}</span>
                          <span title="收藏量">☆ {count(n.collects)}</span>
                        </div>
                        {n.error && (
                          <p className="note-error" title={friendlyFailure(n.error)}>
                            读取失败，可重试
                          </p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    disabled={actualPage <= 1}
                    onClick={() => setPage(actualPage - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {actualPage} / {totalPages}
                  </span>
                  <button
                    disabled={actualPage >= totalPages}
                    onClick={() => setPage(actualPage + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
              <div className="selection-bar">
                <div className="selection-summary">
                  <strong>
                    {p?.selected.length ?? 0}
                    <span> / {p?.limit ?? 10} 篇</span>
                  </strong>
                  <span className="subtle">已选笔记</span>
                  <button
                    className="text-button"
                    disabled={busy || !p?.selected.length}
                    onClick={() => action(() => update({ selected: [] }))}
                  >
                    清除选择
                  </button>
                </div>
                <button
                  className="primary"
                  disabled={
                    busy || !p?.selected.length || job?.status === "running"
                  }
                  onClick={() =>
                    action(async () => {
                      await api("/projects/" + pid + "/desktop-jobs", "POST", {});
                      navigate("tasks", pid);
                      setNotice("任务已创建。复制下方的任务指令，在 Codex Desktop 中发送。");
                    })
                  }
                >
                  创建整理任务 <span aria-hidden="true">→</span>
                </button>
              </div>
            </>
          )}
          {tab === "tasks" && (
            <>
              {!currentJobs.length ? (
                <div className="empty">
                  <h2>还没有整理任务</h2>
                  <p>在笔记库选好笔记后，点击「创建整理任务」。</p>
                  <button className="primary" onClick={() => navigate("library", pid)}>
                    选择笔记
                  </button>
                </div>
              ) : (
                currentJobs.map((j) => (
                  <section className="job" key={j.id}>
                    <div className="section-head">
                      <div>
                        <h2>整理 {j.selected.length} 篇笔记</h2>
                        <p className="subtle">
                          {new Date(j.createdAt).toLocaleString("zh-CN")}
                        </p>
                      </div>
                      <span className={"badge " + j.status}>
                        {statusName[j.status]}
                      </span>
                    </div>
                    <div className="stage-line">
                      {[
                        "获取原始内容",
                        "提取与清洗",
                        "提取 Claim",
                        "生成兼容 Skill",
                        "验证兼容入口",
                        "自动查源与原创性判断",
                        "综合 Thesis 与 Public Axioms",
                        "索引与打包",
                      ].filter(stage => j.executor !== "desktop" || !["生成兼容 Skill", "验证兼容入口"].includes(stage)).map((s, i) => (
                        <div
                          key={s}
                          className={j.stage === s ? "current-stage" : ""}
                        >
                          <span>{i + 1}</span>
                          {jobStages[s]}
                        </div>
                      ))}
                    </div>
                    <p className="current-work">
                      {jobStages[j.stage] ?? "等待下一步"}
                      {j.status === "running" && "…"}
                    </p>
                    {j.error && <p className="warning">{friendlyFailure(j.error, undefined, "请查看下方哪些笔记还没处理完，再继续任务。")}</p>}
                    {j.budget && <p className="subtle">材料预算：已用 {j.budget.used.toLocaleString()} / {j.budget.hardLimit.toLocaleString()} token。这里只估算 Cluefolio 投递的材料，不是 Agent 会话账单。</p>}
                    {j.stage === "预算已用完" && j.budgetEstimate && <div className="budget-recovery">
                      <p>已处理 {j.selected.length - j.budgetEstimate.remainingNotes.length} / {j.selected.length} 篇。还有 {j.budgetEstimate.remainingNotes.length} 篇未完成；继续预计需再增加约 {j.budgetEstimate.additional.toLocaleString()} token（估算值）。</p>
                      <small>待处理：{j.budgetEstimate.remainingTitles.join("、")}</small>
                      <div className="job-actions">
                        <button className="secondary" disabled={busy} onClick={() => action(() => api(`/jobs/${j.id}/finish-partial`, "POST", {}))}>用已完成部分生成草稿</button>
                        <button className="primary" disabled={busy} onClick={() => action(async () => {
                          const target = (j.budget?.hardLimit ?? 1_000_000) + j.budgetEstimate!.additional;
                          await api(`/jobs/${j.id}/budget`, "POST", { hardLimit: target });
                          setNotice(`预算已提高到 ${target.toLocaleString()} token。可以继续原任务。`);
                        })}>增加预计预算</button>
                      </div>
                    </div>}
                    <div className="job-table">
                      <table>
                        <thead>
                          <tr>
                            <th>笔记</th>
                            <th>下载</th>
                            <th>整理内容</th>
                            <th>提取要点</th>
                          </tr>
                        </thead>
                        <tbody>
                          {j.selected.map((nid) => (
                            <tr key={nid}>
                              <td>
                                {p?.notes.find((n) => n.id === nid)?.title ||
                                  "标题尚未读取"}
                                {j.noteStates[nid].error && (
                                  <small className="warning">
                                    {friendlyFailure(j.noteStates[nid].error, undefined, "这篇笔记还没处理完。继续任务时会再试。")}
                                  </small>
                                )}
                                {j.noteStates[nid].clean === "running" &&
                                  j.noteStates[nid].detail && (
                                    <small className="subtle">
                                      {noteProgress(j.noteStates[nid].detail)}
                                    </small>
                                  )}
                              </td>
                              {(["fetch", "clean", "extract"] as const).map(
                                (k) => (
                                  <td key={k}>
                                    <span
                                      className={
                                        "state " + j.noteStates[nid][k]
                                      }
                                    >
                                      {statusName[j.noteStates[nid][k]]}
                                    </span>
                                  </td>
                                ),
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="job-actions">
                      {j.executor === "desktop" && j.status !== "running" && j.status !== "complete" && (
                        <div>
                          <label>
                            在 Codex Desktop 里开始或继续
                            <input readOnly value={`请用 Cluefolio 开始或继续任务 ${j.id}。如果需要我登录或验证，请告诉我。`} onFocus={event => event.currentTarget.select()} />
                          </label>
                          <button onClick={() => action(async () => {
                            await navigator.clipboard.writeText(`请用 Cluefolio 开始或继续任务 ${j.id}。如果需要我登录或验证，请告诉我。`);
                            setNotice("已复制。请粘贴到 Codex Desktop 的对话里发送。");
                          })}>复制任务指令</button>
                        </div>
                      )}
                      {j.status === "running" ? (
                        <button
                          onClick={() =>
                            action(() =>
                              api("/jobs/" + j.id + "/cancel", "POST", {}),
                            )
                          }
                        >
                          {j.executor === "desktop" ? "暂停任务" : "取消任务"}
                        </button>
                      ) : (
                        j.executor !== "desktop" && j.status !== "complete" && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              action(() =>
                                api("/jobs/" + j.id + "/resume", "POST", {}),
                              )
                            }
                          >
                            继续任务
                          </button>
                        )
                      )}
                      {j.executor !== "desktop" && j.status !== "running" && j.status !== "complete" && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            action(() =>
                              api("/jobs/" + j.id + "/resume", "POST", {
                                offline: true,
                              }),
                            )
                          }
                        >
                          用已下载的笔记继续
                        </button>
                      )}
                      <button
                        className="secondary"
                        onClick={() => {
                          setResultJobId(j.id);
                          navigate("results", j.projectId);
                        }}
                      >
                        查看处理结果
                      </button>
                    </div>
                  </section>
                ))
              )}
            </>
          )}
          {tab === "results" && (
            <>
              {!job ? (
                <div className="empty">
                  <h2>这里还没有处理结果</h2>
                  <p>选好笔记并完成整理后，这里会显示结果和下载入口。</p>
                </div>
              ) : (
                <>
                  <div className="result-head">
                    <div>
                      <h2>{p?.name ?? "笔记整理结果"}</h2>
                      <p>
                        {job.status === "complete"
                          ? (job.executor === "desktop" ? "Context 已准备好，可在 Agent 聊天中选择 Skill 提问。" : "检查已通过，可以下载结果或安装技能。")
                          : "目前只展示已完成的部分。"}
                      </p>
                      {job.context && (
                        <p className="subtle">
                          {job.context.status === "complete" ? "Context 已就绪" : "Context 草稿"} · 调用 Skill：{job.context.skillName ?? job.context.contextId} · 已为 {job.context.processedClaims}/{job.context.totalClaims} 条观点查找出处
                        </p>
                      )}
                    </div>
                    <div className="job-actions">
                      {result?.downloadReady && (
                        <>
                          <a
                            className="button secondary"
                            href={"/api/jobs/" + job.id + "/download"}
                          >
                            下载 Codex 技能
                          </a>
                          <a
                            className="button secondary"
                            href={
                              "/api/jobs/" + job.id + "/download?sources=true"
                            }
                          >
                            下载原文和出处
                          </a>
                        </>
                      )}
                      {job.context && (
                        <button className="secondary" onClick={() => {
                          setContextByProject(previous => ({ ...previous, [job.projectId]: job.context!.contextId }));
                          navigate("context", job.projectId);
                        }}>打开 Context</button>
                      )}
                      {job.status !== "running" && job.context && (
                        <button
                          className="primary"
                          onClick={() =>
                            action(async () => {
                              await api(
                                "/jobs/" + job.id + "/install",
                                "POST",
                                {},
                              );
                              setNotice("调用 Skill 已安装。在 Agent 任务聊天中选择它提问。");
                            })
                          }
                        >
                          重新安装调用 Skill
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="result-columns">
                    <section>
                      {job.executor === "desktop" ? (
                        <>
                          <h3>Context 文件</h3>
                          <p>{job.context ? "查看笔记要点和出处，回看相关原文。" : "任务完成后，可以在这里查看和下载 Context。"}</p>
                          {job.context && <a className="button secondary" href={`/api/contexts/${job.context.contextId}/download?version=${job.context.version}`}>下载 Context</a>}
                          {job.context && <>
                            <h3>调用 Skill：{job.context.skillName ?? job.context.contextId}</h3>
                            <p>在 Agent 任务聊天中选择这个 Skill 提问；它会从本机 Context 读取依据。</p>
                            <pre className="document">{result?.skill || "正在读取调用 Skill…"}</pre>
                          </>}
                        </>
                      ) : (
                        <>
                          <h3>Codex 技能预览</h3>
                          <pre className="document">
                            {result?.skill || "技能还在准备中。已下载的笔记可以先在笔记库查看。"}
                          </pre>
                        </>
                      )}
                    </section>
                    <section>
                      <h3>处理检查</h3>
                      {result?.quality ? (
                        <>
                          <p>
                            {result.quality.processed.length} /{" "}
                            {result.quality.selected.length} 篇处理完成
                          </p>
                          <p>{result.quality.methods} 条可查出处的方法</p>
                          {result.quality.resolvedIssues?.length > 0 && (
                            <p>
                              {result.quality.resolvedIssues.length}{" "}
                              处内容已核对。下载原文和出处可查看核对记录。
                            </p>
                          )}
                          {result.quality.criticalIssues?.length > 0 && (
                            <p className="warning">
                              仍有 {result.quality.criticalIssues.length}{" "}
                              处内容需要核对，任务暂时无法完成。
                            </p>
                          )}
                          {result.quality.behavioralEvaluation?.cases?.map(
                            (c: any) => (
                              <div className="test-case" key={c.name}>
                                <strong>
                                  {c.passed ? "✓" : "!"} {c.name}
                                </strong>
                                <p>{c.reason}</p>
                                <small>
                                  使用技能前后（满分 5 分） · 是否符合原文{" "}
                                  {c.baselineFaithfulness ?? "—"} →{" "}
                                  {c.faithfulness} · 追问是否有用{" "}
                                  {c.baselineQuestionQuality ?? "—"} →{" "}
                                  {c.questionQuality} · 任务完成度{" "}
                                  {c.baselineCompletion ?? "—"} → {c.completion}
                                </small>
                              </div>
                            ),
                          )}
                          {result.quality.behavioralEvaluation?.issues?.map(
                            (issue: string, i: number) => (
                              <p key={i} className="warning">
                                {issue}
                              </p>
                            ),
                          )}
                          {result.quality.missing?.length > 0 && (
                            <p className="warning">
                              仍有 {result.quality.missing.length}{" "}
                              篇笔记还没处理完。下载原文和出处可查看清单。
                            </p>
                          )}
                          <p className="subtle">
                            {job.executor === "desktop" ? "自动检查会确认文件是否齐全，以及能否找到原始出处。" : "这里显示的是自动测试结果。"}
                          </p>
                        </>
                      ) : (
                        <p className="subtle">整理和检查完成后，这里会显示结果。</p>
                      )}
                    </section>
                  </div>
                  {result?.methods?.length > 0 && (
                    <section className="methods">
                      <h3>从笔记整理出的方法</h3>
                      {result.methods.map((m: any) => (
                        <details key={m.id}>
                          <summary>
                            {m.title}
                            <small>
                              {
                                {
                                  explicit: "作者直接提出",
                                  inferred: "根据笔记推导",
                                  external: "其他来源补充",
                                }[m.level as string]
                              }
                            </small>
                          </summary>
                          <p>{m.problem}</p>
                          <p>什么时候适用 {m.conditions.join("；")}</p>
                          <p>先问清楚 {m.questions.join("；")}</p>
                          <ol>
                            {m.steps.map((s: string, i: number) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                          <p>可以这样做 {m.actions.join("；")}</p>
                          <p>需要留意 {m.exceptions.join("；")}</p>
                          <p className="subtle">
                            相关笔记
                            {m.evidence.map((e: any, i: number) => (
                              <button
                                key={i}
                                className="text-button"
                                onClick={() => {
                                  const note = p?.notes.find(
                                    (n) => n.id === e.noteId,
                                  );
                                  if (note) void openNote(note, e.segmentId);
                                }}
                              >
                                {p?.notes.find((n) => n.id === e.noteId)
                                  ?.title || e.noteId}{" "}
                                · 片段 {i + 1}
                              </button>
                            ))}
                          </p>
                        </details>
                      ))}
                    </section>
                  )}
                </>
              )}
            </>
          )}
          {tab === "context" && (
            <>
              <header className="search-intro">
                <div>
                  <h1>{pages.context.title}</h1>
                  <p>{pages.context.description}</p>
                </div>
                <svg className="search-illustration" viewBox="0 0 260 132" aria-hidden="true" fill="none">
                  <path d="M48 30h115l29 20v65H48z" fill="#f7ded8" stroke="#d7a49d"/>
                  <path d="M62 17h112l30 22v64H62z" fill="#fcf0eb" stroke="#d7a49d"/>
                  <path d="M77 5h109l27 24v65H77z" fill="#fffaf6" stroke="#c88c86"/>
                  <path d="M186 5v24h27M94 31h62M94 45h83M94 59h62M94 73h41" stroke="#c88c86"/>
                  <circle cx="178" cy="73" r="23" fill="#fffaf6" stroke="#9b252c" strokeWidth="1.8"/>
                  <path d="m194 90 23 22M168 73h20M178 63v20" stroke="#9b252c" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </header>
              <section className="search-shell" aria-label="从笔记中查找答案">
                <div className="search-card">
                  <div className="search-scope">
                    <label htmlFor="section-project">当前项目
                      <select id="section-project" value={pid} disabled={(!projects.length && !standaloneContexts.length) || busy} onChange={event => changeProject(event.target.value)}>
                        {!projects.length && !standaloneContexts.length && <option value="">还没有项目</option>}
                        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                        {!!standaloneContexts.length && <option value={standaloneScope}>独立导入的 Context</option>}
                      </select>
                    </label>
                    {selectedContext && <label htmlFor="context-picker">搜索范围
                      <select id="context-picker" value={contextId} disabled={busy} onChange={event => {
                        const id = event.target.value;
                        setContextByProject(previous => ({ ...previous, [pid]: id }));
                      }}>
                        {projectContexts.map(item => <option key={item.contextId} value={item.contextId}>{item.name} · {item.version}{item.status === "draft" ? " · 草稿" : ""}</option>)}
                      </select>
                    </label>}
                    {(p || selectedContext) && <button type="button" className="secondary" onClick={() => navigate("new")}>新建项目</button>}
                  </div>
                  {selectedContext ? (
                    <form className="question-form" onSubmit={event => {
                      event.preventDefault();
                      if (busy || !contextQuery.trim()) return;
                      void action(async () => setContextPacket(await api(`/contexts/${contextId}/packet`, "POST", {
                        query: contextQuery, version: contextVersion, maxChars: 30000,
                      })));
                    }}>
                      <label htmlFor="question">你想查什么？</label>
                      <div className="question-field">
                        <input id="question" value={contextQuery} onChange={event => setContextQuery(event.target.value)} placeholder="输入一个问题或关键词" />
                        <button className="primary search-submit" disabled={busy || !contextQuery.trim()}>
                          查找相关笔记<span aria-hidden="true">↗</span>
                        </button>
                      </div>
                      <div className="question-footer">
                        <p>{selectedContext.status === "complete"
                          ? `从这个 Context 的 ${selectedContext.counts.documents} 个来源里查找。`
                          : "当前是草稿，只搜索已整理的内容。"}</p>
                        <button type="button" className="text-button" disabled={!contextQuery.trim()} onClick={() => action(async () => {
                          await navigator.clipboard.writeText(`请用 Cluefolio Context ${contextId}（版本 ${contextVersion}）回答以下问题，并附上可以打开的出处。\n${contextQuery}`);
                          setNotice("已复制问题。请粘贴到 Codex 对话里发送。");
                        })}>复制问题到 Codex</button>
                      </div>
                    </form>
                  ) : (
                    <div className="search-empty">
                      <h2>{!loaded ? "正在加载项目…" : p ? "这个项目还没有可搜索的 Context" : "先建一个项目"}</h2>
                      {loaded && <><p>{p
                        ? "先导入并整理笔记。完成后，就能在这里提问和查原文。"
                        : "导入你想反复查阅的笔记，整理完成后就可以提问。"}</p>
                      <button className="primary" onClick={() => p ? navigate("library", pid) : navigate("new")}>{p ? "打开这个项目的笔记库" : "新建第一个项目"}</button></>}
                    </div>
                  )}
                </div>
              </section>
                  {contextPacket?.context.id === contextId && contextPacket.context.version === contextVersion && (
                    <section className="job search-results" aria-live="polite">
                      <h3>相关笔记和出处</h3>
                      <p className="subtle">{contextPacket.evidence.length
                        ? "打开下方条目可以核对原文。需要完整回答时，把问题发给 Codex。"
                        : "没有找到相关原文。试试换个关键词，或把问题缩小到一个主题。"}</p>
                      {contextPacket.recommendations?.length > 0 && <div><h4>值得先看的来源</h4>{contextPacket.recommendations.map((item: any) => <p key={item.url}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a><br/><small>{sourceDate(item.publishedAt)} · {item.kind === "upstream" ? "可查看这条观点的原作。" : item.kind === "reading-lead" ? "可打开原页面进一步查阅。" : "可查看博主怎样解释或应用这条观点。"}</small></p>)}</div>}
                      <div className="methods">
                        {contextPacket.evidence.map((item: any) => {
                          const sourceProject = projects.find(project => project.id === selectedContext?.sourceProjectId);
                          const sourceNote = sourceProject?.notes.find(note => `xhs-${note.id}` === item.source.id);
                          return <details key={item.id}>
                            <summary>{item.source.title} · {item.locator.page ? `第 ${item.locator.page} 页` : item.locator.start !== undefined ? `${item.locator.start.toFixed(1)}–${item.locator.end.toFixed(1)} 秒` : "正文"}</summary>
                            <p>{item.text}</p>
                            <small>{sourceDate(item.source.publishedAt)} · 涉及价格、规则、市场数字时，请核对当前一手来源。</small>
                            <div className="review-actions">
                              {sourceNote && sourceProject && <button className="text-button" onClick={() => void openNote(sourceNote, item.locator.segmentId, sourceProject.id, item.locator.start, item.locator.page)}>查看对应片段</button>}
                              <a href={item.locator.url || item.source.url} target="_blank" rel="noreferrer">打开来源网页</a>
                            </div>
                          </details>;
                        })}
                      </div>
                    </section>
                  )}
              {overview && (
                <>
                  <div className="knowledge-heading">
                    <h2>Context 内容</h2>
                    <a className="button secondary" href={`/api/contexts/${contextId}/download?version=${contextVersion}`}>下载 Context</a>
                  </div>
                  {overview.manifest.status !== "complete" && !overview.manifest.capabilities.includes("agent-driven") && (
                    <button className="secondary" disabled={busy} onClick={() => action(async () => {
                      await api(`/contexts/${contextId}/build`, "POST", { version: contextVersion });
                      setNotice("正在继续核对来源。任务沿用原来的剩余额度。");
                    })}>继续核对来源</button>
                  )}
                  <div className="context-statements result-columns">
                    <section>
                      <h3>主要观点</h3>
                      {overview.theses?.map((item: any) => (
                        <details key={item.id} open>
                          <summary>{item.title}</summary>
                          <p>{item.statement}</p>
                          <small>{sourceDate(item.temporal?.sourceDate)}{item.temporal?.sensitivity === "time-sensitive" ? " · 给执行建议前需重查当前来源" : " · 使用前核对适用条件"}</small>
                          <small>适用范围 {item.scope.join("；") || "查看出处"}</small>
                          {!!item.exceptions.length && <small>例外 {item.exceptions.join("；")}</small>}
                          {item.claimIds.map((id: string, index: number) => <button key={id} className="text-button" onClick={() => setFocusClaim({ id })}>查看出处 {index + 1}</button>)}
                        </details>
                      ))}
                    </section>
                    <section>
                      <h3>判断原则</h3>
                      {overview.axioms?.map((item: any) => (
                        <details key={item.id}>
                          <summary>{item.title}</summary>
                          <p>{item.statement}</p>
                          <small>{sourceDate(item.temporal?.sourceDate)}{item.temporal?.sensitivity === "time-sensitive" ? " · 给执行建议前需重查当前来源" : " · 使用前核对适用条件"}</small>
                          <small>适用条件 {item.conditions.join("；") || "查看出处"}</small>
                          {!!item.exceptions.length && <small>例外 {item.exceptions.join("；")}</small>}
                          {item.claimIds.map((id: string, index: number) => <button key={id} className="text-button" onClick={() => setFocusClaim({ id })}>查看出处 {index + 1}</button>)}
                        </details>
                      ))}
                    </section>
                  </div>
                  {overview && <AttributionPanel key={contextId + contextVersion}
                    focusClaim={focusClaim} load={loadAttribution} save={(claimId, review) => api(`/contexts/${contextId}/claims/${claimId}/review`, "PUT", { version: contextVersion, review })}
                    saveAuthor={(sourceId, review) => api(`/contexts/${contextId}/sources/${sourceId}/author`, "PUT", { version: contextVersion, review })}
                    onChange={() => { setContextPacket(null); setContextQuality(null); }} />}
                  <section className="context-card">
                    <h2>检查结果</h2>
                    <p className="subtle">查看文件是否齐全、多少观点已核对来源，以及搜索测试的结果。</p>
                    <button disabled={busy} onClick={() => action(async () =>
                      setContextQuality(await api(`/contexts/${contextId}/evaluation?version=${contextVersion}`)))}>查看检查结果</button>
                    {contextQuality && <div className="quality-summary">
                      <p><strong>{contextQuality.integrity ? "文件检查通过" : "部分文件缺失或有改动"}</strong> · {contextQuality.resolved}／{contextQuality.total} 条观点已完成来源检查 · {contextQuality.statements} 条观点和原则 · {contextQuality.reviews} 处已手动更正</p>
                      {contextQuality.failures.map((file: string) => <p className="warning" key={file}>{file}</p>)}
                      {contextQuality.metrics && <p>前 10 条搜索结果覆盖的参考内容 {(contextQuality.metrics.recallAt10 * 100).toFixed(1)}% · 推荐原作正确率 {contextQuality.metrics.upstreamPrecision == null ? "暂未测得" : `${(contextQuality.metrics.upstreamPrecision * 100).toFixed(1)}%`} · 把原创误判为搬运的比例 {(contextQuality.metrics.falseDerivativeRate * 100).toFixed(1)}%</p>}
                      {!contextQuality.metrics && <p className="subtle">这个 Context 还没有搜索和来源推荐的测试记录。</p>}
                      {contextQuality.timings.length > 0 && <p className="subtle">各步骤用时 {contextQuality.timings.map((item: any) => `${stageTimingLabels[item.stage] ?? "处理笔记"} ${(item.elapsedMs / 1000).toFixed(1)} 秒`).join(" · ")}</p>}
                    </div>}
                  </section>
                </>
              )}
            </>
          )}
          {tab === "settings" && (
            <div className="settings-columns">
              {p && (
                <section>
                  <h2>当前项目</h2>
                  <form
                    key={pid}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void action(() =>
                        update({
                          name: f.get("name"),
                          skillName: f.get("skillName"),
                          purpose: f.get("purpose"),
                          limit: Number(f.get("limit")),
                          tokenBudget: Number(f.get("tokenBudget")),
                        }),
                      );
                    }}
                  >
                    <label>
                      项目名称
                      <input name="name" required defaultValue={p.name} />
                    </label>
                    <label>
                      Context 标识
                      <input
                        name="skillName"
                        required
                        pattern="[a-z0-9][a-z0-9_-]{0,63}"
                        defaultValue={p.skillName}
                      />
                      <small>用于在 Agent 中找到这个 Context。请用小写字母、数字、短横线或下划线。</small>
                    </label>
                    <label>
                      每次最多选几篇
                      <input
                        name="limit"
                        type="number"
                        min="1"
                        max="100"
                        required
                        defaultValue={p.limit}
                      />
                      <small>默认 10 篇，可填 1 到 100。</small>
                    </label>
                    <label>
                      每项任务的材料预算
                      <input name="tokenBudget" type="number" min="10000" max="20000000" step="10000" required defaultValue={p.tokenBudget ?? 1000000} />
                      <small>默认 1,000,000 token。预算用完会暂停；可生成草稿或增加预算继续。</small>
                    </label>
                    <label>
                      你想用这个 Context 做什么
                      <textarea
                        name="purpose"
                        rows={5}
                        defaultValue={p.purpose}
                        placeholder="可留空。Cluefolio 会根据笔记内容建议用途。"
                      />
                    </label>
                    <button className="primary" disabled={busy}>
                      保存设置
                    </button>
                  </form>
                </section>
              )}
            </div>
          )}
          {tab === "new" && (
            <div className="new-project-shell">
              <section className="new-project-form">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const x = await api<Project>("/projects", "POST", {
                        name: newName.trim(),
                        skillName: "creator-advisor",
                        limit: 10,
                      });
                      setProjectByPage({ context: x.id, library: x.id, tasks: x.id, results: x.id, settings: x.id });
                      setNewName("");
                      setLinks("");
                      setProfile("");
                      setQuery("");
                      setKind("all");
                      setResultJobId("");
                      navigate("library", x.id);
                      setNotice(`「${x.name}」已创建。现在可以导入笔记。`);
                    });
                  }}
                >
                  <label>
                    项目名称
                    <input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      required
                      placeholder="例如，产品研究笔记"
                    />
                  </label>
                  <div className="new-project-actions">
                    <button className="primary" disabled={busy || !newName.trim()}>创建并导入笔记</button>
                    <button type="button" disabled={busy} onClick={() => navigate(returnPage)}>返回</button>
                  </div>
                </form>
              </section>
            </div>
          )}
        </div>
      </main>
      {viewed && (
        <div className="modal-backdrop" onClick={() => setViewed(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="笔记详情"
            className="note-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-head">
              <h2>{viewed.title || "标题尚未读取"}</h2>
              <button
                autoFocus
                aria-label="关闭笔记详情"
                onClick={() => setViewed(null)}
              >
                关闭
              </button>
            </div>
            {!detail ? (
              <p>正在打开笔记…</p>
            ) : (
              <>
                <div className="media-strip">
                  {detail.media
                    ?.filter((m: any) => m.ready)
                    .map((m: any) =>
                      m.type === "video" ? (
                        <video
                          key={m.index}
                          ref={videoRef}
                          onLoadedMetadata={seekEvidence}
                          controls
                          preload="metadata"
                          src={`/api/projects/${viewedProject}/notes/${viewed.id}/media/${m.index}`}
                        />
                      ) : (
                        <img
                          key={m.index}
                          id={m.page ? "media-page-" + m.page : undefined}
                          alt={"原始配图 " + m.page}
                          src={`/api/projects/${viewedProject}/notes/${viewed.id}/media/${m.index}`}
                        />
                      ),
                    )}
                </div>
                <div className="comparison">
                  <section>
                    <h3>原文、图片文字和视频口播</h3>
                    <pre id="source-body">{detail.body ?? "正文还没读到。"}</pre>
                    {detail.segments
                      ?.filter((s: any) => s.kind !== "body")
                      .map((s: any) => (
                        <p key={s.id} id={"source-" + s.id}>
                          <small>
                            {s.start !== undefined ? (
                              <button
                                className="text-button"
                                onClick={() => {
                                  if (videoRef.current)
                                    videoRef.current.currentTime = s.start;
                                }}
                              >
                                {s.start.toFixed(1)}s ↗
                              </button>
                            ) : (
                              ""
                            )}
                            {s.page ? "第 " + s.page + " 页" : ""}
                          </small>
                          <br />
                          {s.text}
                        </p>
                      ))}
                  </section>
                  <section>
                    <h3>整理后的文字</h3>
                    <pre>
                      {detail.analysis?.clean.cleanText ??
                        "笔记整理完成后，文字会显示在这里。"}
                    </pre>
                    {detail.analysis?.clean.issues.map((i: any, k: number) => (
                      <p className="warning" key={k}>
                        {i.location}：{i.message}
                      </p>
                    ))}
                  </section>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
