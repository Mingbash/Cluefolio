import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomic,
  browserLease,
  hashFile,
  json,
  metric,
  parseLink,
  parseOutput,
  run,
  sleep,
  TaskError,
} from "./util.ts";
import type { Config, Note, Provider, RawNote, Media } from "./types.ts";
export function normalizeCard(n: any, authorId = "", source = "opencli"): Note {
  const id = String(n.id ?? n.noteId ?? n.note_id ?? "");
  if (!/^[a-f0-9]{24}$/i.test(id))
    throw new TaskError("PARSE", "笔记列表含无效 ID");
  const token = n.xsecToken ?? n.xsec_token;
  return {
    version: 1,
    id,
    url:
      n.url ??
      `https://www.xiaohongshu.com/explore/${id}${token ? "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_user" : ""}`,
    authorId: n.authorId || authorId,
    author: n.author || "",
    title: n.title || "",
    cover: n.cover || null,
    type:
      n.type === "video"
        ? "video"
        : ["normal", "image"].includes(n.type)
          ? "image"
          : n.type === "text"
            ? "text"
            : "unknown",
    publishedAt: n.publishedAt
      ? typeof n.publishedAt === "number"
        ? new Date(n.publishedAt).toISOString()
        : n.publishedAt
      : null,
    likes: metric(n.likes),
    collects: metric(n.collects),
    status: "pending",
    source,
  };
}
export function normalizeDetail(
  s: any,
  url: string,
  source = "opencli",
): RawNote {
  const d = s.detail ?? s.note ?? s;
  const id = String(d.noteId ?? d.note_id ?? d.id ?? parseLink(url).id);
  if (!/^[a-f0-9]{24}$/i.test(id))
    throw new TaskError("PARSE", "详情缺少有效笔记 ID");
  const ui = d.user ?? {};
  const info = d.interactInfo ?? d.interact_info ?? {};
  const images = d.imageList ?? d.image_list ?? [];
  const media: Media[] = images
    .map((im: any, i: number) => ({
      type: "image",
      page: i + 1,
      url:
        im.urlDefault ??
        im.url_default ??
        im.url ??
        im.infoList?.find((x: any) => x.imageScene === "WB_DFT")?.url ??
        im.info_list?.[0]?.url,
    }))
    .filter((m: Media) => m.url);
  if (media.length !== images.length)
    throw new TaskError(
      "CONTENT_MISSING",
      "部分配图缺少下载地址，不能跳过缺页",
    );
  const v = d.video;
  const stream = Object.values(v?.media?.stream ?? {}).flat() as any[];
  let video =
    stream.find((x: any) => x.masterUrl)?.masterUrl ??
    v?.url ??
    v?.consumer?.originVideoKey ??
    v?.originVideoKey;
  if (video) {
    if (!video.startsWith("http"))
      video = "https://sns-video-bd.xhscdn.com/" + video;
    media.unshift({ type: "video", url: video });
  }
  const body = d.desc ?? d.description ?? s.bodyText ?? null;
  const n = normalizeCard(
    {
      id,
      url,
      authorId: ui.userId ?? ui.user_id,
      author: ui.nickname ?? s.domAuthor,
      title: d.title ?? s.domTitle,
      type:
        d.type === "normal" &&
        Array.isArray(d.imageList ?? d.image_list) &&
        images.length === 0
          ? "text"
          : (d.type ?? (video ? "video" : images.length ? "image" : "text")),
      cover: images[0]?.urlDefault ?? images[0]?.url ?? null,
      likes: info.likedCount ?? info.liked_count ?? s.metrics?.likes,
      collects:
        info.collectedCount ?? info.collected_count ?? s.metrics?.collects,
      publishedAt: d.time ?? d.publish_time,
    },
    "",
    source,
  );
  if (n.type === "image" && !media.length)
    throw new TaskError("CONTENT_MISSING", "图文笔记未返回配图");
  if (n.type === "video" && !video)
    throw new TaskError("CONTENT_MISSING", "视频地址缺失");
  n.status = "complete";
  n.fetchedAt = new Date().toISOString();
  return {
    version: 1,
    note: n,
    body,
    bodyStatus: body !== null ? "ready" : "missing",
    tags: (d.tagList ?? d.tag_list ?? []).map((x: any) => x.name),
    media,
    subtitles: Array.isArray(s.subtitles) ? s.subtitles : [],
    subtitleStatus: Array.isArray(s.subtitles)
      ? s.subtitles.length
        ? "ready"
        : "not-exposed"
      : "not-inspected",
    raw: s,
    fetchedAt: n.fetchedAt,
  };
}
export class OpenCLIProvider implements Provider {
  name = "opencli";
  constructor(private cfg: Config) {}
  async detail(url: string, signal?: AbortSignal) {
    const rows = parseOutput<any[]>(
      await run(
        this.cfg.opencliBin,
        ["xhs-distiller", "detail", url, "-f", "json"],
        { signal, timeout: 90000 },
      ),
    );
    return normalizeDetail(rows[0]?.data, url);
  }
  async scan(
    url: string,
    onPage: (n: Note[], complete: boolean) => void,
    signal?: AbortSignal,
  ) {
    const id = parseLink(url, true).id;
    const file = path.join(this.cfg.dataDir, "scans", randomUUID() + ".json");
    await mkdir(path.dirname(file), { recursive: true });
    let busy = false;
    let lastSnapshot = "";
    const emit = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await json<any>(file);
        const stamp = s
          ? `${s.iterations}:${s.complete}:${s.notes.length}`
          : "";
        if (s && stamp !== lastSnapshot) {
          lastSnapshot = stamp;
          onPage(
            s.notes.map((n: any) => normalizeCard(n, id)),
            s.complete,
          );
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void emit().catch(() => {});
    }, 1000);
    try {
      const out = await run(
        this.cfg.opencliBin,
        ["xhs-distiller", "scan", url, "--output", file, "-f", "json"],
        { signal, timeout: 3600000 },
      );
      await emit();
      return parseOutput<any[]>(out)[0];
    } finally {
      clearInterval(timer);
      await emit();
      await rm(file, { force: true });
    }
  }
}
export class GuaikeiProvider implements Provider {
  name = "guaikei";
  constructor(private enabled: boolean) {}
  async request(
    route: string,
    params: Record<string, string | number>,
    create = false,
    signal?: AbortSignal,
  ) {
    if (!this.enabled || !process.env.GUAIKEI_API_TOKEN)
      throw new TaskError("CONFIG", "Guaikei 未启用或缺少密钥");
    const u = new URL("https://www.guaikei.com/api/xiaohongshu/" + route);
    u.searchParams.set("token", process.env.GUAIKEI_API_TOKEN);
    u.searchParams.set("_", String(Date.now()));
    if (!create)
      for (const [k, v] of Object.entries(params))
        u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method: create ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: create ? JSON.stringify(params) : undefined,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new TaskError("API", `数据接口 HTTP ${res.status}`);
    const x: any = await res.json();
    if (x.errcode !== undefined && x.errcode !== 0)
      throw new TaskError(
        "API",
        String(x.errmsg || x.message || "数据接口失败"),
      );
    return x;
  }
  async task(kind: string, url: string, limit: number, signal?: AbortSignal) {
    await this.request(kind + "/url", { url, limit }, true, signal);
    for (let i = 0; i < 60; i++) {
      await sleep(3000, signal);
      const x = await this.request(
        kind + "/info",
        { url, limit },
        false,
        signal,
      );
      const d = x.data;
      if (
        d &&
        (d.id ||
          d.note_id ||
          d.noteId ||
          Array.isArray(d.results) ||
          Array.isArray(d.notes))
      )
        return d;
      if (["failed", "error"].includes(d?.status))
        throw new TaskError("API", "采集服务报告失败");
    }
    throw new TaskError("TIMEOUT", "数据服务尚未完成，可稍后恢复");
  }
  async detail(url: string, signal?: AbortSignal) {
    return normalizeDetail(
      await this.task("detail", url, 0, signal),
      url,
      "guaikei",
    );
  }
  async scan(
    url: string,
    onPage: (n: Note[], c: boolean) => void,
    signal?: AbortSignal,
  ) {
    const d = await this.task("post", url, 10000, signal);
    const id = parseLink(url, true).id;
    const notes = (d.results ?? d.notes ?? []).map((n: any) =>
      normalizeCard(
        {
          id: n.id ?? n.note_id,
          title: n.title,
          cover: n.cover?.url ?? n.cover,
          type: n.type,
          likes: n.liked_count ?? n.likes,
          collects: n.collected_count ?? n.collects,
          xsec_token: n.xsec_token,
          url: n.url,
          author: n.user?.nickname,
        },
        id,
        "guaikei",
      ),
    );
    const complete = d.has_more === false || d.hasMore === false;
    onPage(notes, complete);
    return {
      complete,
      reason: complete ? undefined : "接口未提供明确遍历结束标记",
    };
  }
}
export class Acquisition {
  private tail: Promise<any> = Promise.resolve();
  private last = 0;
  primary: Provider;
  fallback: Provider;
  constructor(
    public cfg: Config,
    provider?: Provider,
  ) {
    this.primary = provider ?? new OpenCLIProvider(cfg);
    this.fallback = new GuaikeiProvider(cfg.guaikeiEnabled);
  }
  async serial<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        await sleep(
          Math.max(0, this.cfg.requestIntervalMs - (Date.now() - this.last)),
          signal,
        );
        try {
          return await browserLease(
            this.cfg.dataDir,
            fn,
            signal,
            this.cfg.requestIntervalMs,
          );
        } finally {
          this.last = Date.now();
        }
      });
    this.tail = work;
    return work;
  }
  async detail(url: string, signal?: AbortSignal) {
    return this.serial(async () => {
      for (let i = 0; ; i++) {
        try {
          return await this.primary.detail(url, signal);
        } catch (e: any) {
          if (
            signal?.aborted ||
            [
              "AUTH_REQUIRED",
              "SECURITY_BLOCK",
              "CANCELLED",
              "CONTENT_MISSING",
            ].includes(e.code)
          )
            throw e;
          if (i < 2 && ["TIMEOUT", "PROCESS"].includes(e.code)) {
            await sleep(3000 * (i + 1), signal);
            continue;
          }
          if (
            this.cfg.guaikeiEnabled &&
            ["BROWSER_CONNECT", "PARSE", "PROCESS"].includes(e.code)
          )
            return this.fallback.detail(url, signal);
          throw e;
        }
      }
    }, signal);
  }
  async scan(
    url: string,
    cb: (n: Note[], c: boolean) => void,
    signal?: AbortSignal,
  ) {
    return this.serial(async () => {
      try {
        return await this.primary.scan(url, cb, signal);
      } catch (e: any) {
        if (
          this.cfg.guaikeiEnabled &&
          ["BROWSER_CONNECT", "PARSE"].includes(e.code)
        )
          return this.fallback.scan(url, cb, signal);
        throw e;
      }
    }, signal);
  }
}
function allowedMedia(u: URL) {
  return (
    ["https:", "http:"].includes(u.protocol) &&
    ["xhscdn.com", "xiaohongshu.com"].some(
      (h) => u.hostname === h || u.hostname.endsWith("." + h),
    )
  );
}
export async function downloadMedia(
  media: Media,
  file: string,
  signal?: AbortSignal,
  throttle?: { root: string; intervalMs: number },
) {
  if (media.path && media.sha256) {
    try {
      if ((await hashFile(media.path)) === media.sha256) return media;
    } catch {}
  }
  const initial = new URL(media.url);
  if (!allowedMedia(initial))
    throw new TaskError("MEDIA_HOST", "媒体来源不是小红书 CDN");
  for (let attempt = 0; attempt < 3; attempt++) {
    let url = initial;
    try {
      const transfer = async () => {
        let res: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          res = await fetch(url, {
            redirect: "manual",
            headers: {
              Referer: "https://www.xiaohongshu.com/",
              "User-Agent": "Mozilla/5.0",
            },
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
              : AbortSignal.timeout(300000),
          });
          if (res.status >= 300 && res.status < 400) {
            url = new URL(res.headers.get("location") || "", url);
            if (!allowedMedia(url))
              throw new TaskError("MEDIA_HOST", "媒体重定向超出允许来源");
            continue;
          }
          break;
        }
        if (res && [401, 403, 404, 410].includes(res.status))
          throw new TaskError(
            "MEDIA_EXPIRED",
            `媒体地址不可用 HTTP ${res.status}，需要刷新详情`,
          );
        if (!res?.ok || !res.body)
          throw new TaskError("MEDIA", `媒体下载失败 HTTP ${res?.status}`);
        await mkdir(path.dirname(file), { recursive: true });
        const { createWriteStream } = await import("node:fs");
        const { pipeline } = await import("node:stream/promises");
        const { Readable } = await import("node:stream");
        await pipeline(
          Readable.fromWeb(res.body as any),
          createWriteStream(file + ".part", { mode: 0o600 }),
          { signal },
        );
        const size = (await stat(file + ".part")).size;
        if (!size) throw new TaskError("MEDIA", "媒体为空");
        const { rename } = await import("node:fs/promises");
        await rename(file + ".part", file);
        return { ...media, path: file, sha256: await hashFile(file) };
      };
      return throttle
        ? await browserLease(
            throttle.root,
            transfer,
            signal,
            throttle.intervalMs,
          )
        : await transfer();
    } catch (e: any) {
      if (
        signal?.aborted ||
        attempt === 2 ||
        ["MEDIA_HOST", "MEDIA_EXPIRED"].includes(e.code)
      )
        throw e;
      await sleep(3000 * (attempt + 1), signal);
    }
  }
  throw new Error("媒体下载失败");
}
