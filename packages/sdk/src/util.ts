import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
import type { Metric } from "./types.ts";
export class TaskError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}
export function parseLink(input: string, profile = false) {
  let u: URL;
  try {
    u = new URL(input.replace(/\\([&_])/g, "$1"));
  } catch {
    throw new TaskError("INVALID_URL", "请输入完整的小红书链接");
  }
  if (
    !["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"].includes(
      u.hostname,
    ) ||
    !["https:", "http:"].includes(u.protocol)
  )
    throw new TaskError("INVALID_URL", "仅接受小红书官方链接");
  if (u.hostname === "xhslink.com") return { id: "", url: u.href, short: true };
  const m = u.pathname.match(
    profile
      ? /^\/user\/profile\/([a-f0-9]{24})\/?$/
      : /\/(?:explore|discovery\/item|user\/profile\/[a-f0-9]{24})\/([a-f0-9]{24})\/?$/i,
  );
  if (!m)
    throw new TaskError(
      "INVALID_URL",
      profile ? "需要博主主页链接" : "需要笔记详情链接",
    );
  return { id: m[1], url: u.href, short: false };
}
export const canonical = (id: string) =>
  `https://www.xiaohongshu.com/explore/${id}`;
export function redact(s: string) {
  const configured = process.env.GUAIKEI_API_TOKEN;
  if (configured) s = s.split(configured).join("[REDACTED]");
  return s
    .replace(
      /([?&](?:xsec_token|token|key|api_key)=)[^&\s"<>]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{15,})\b/g, "[REDACTED]");
}
export function metric(raw: unknown): Metric {
  if (raw === null || raw === undefined || raw === "")
    return { raw: null, value: null, approximate: false, status: "pending" };
  const s = String(raw).trim();
  const m = s.match(/^([\d,.]+)\s*([万亿wk]?)\+?$/i);
  if (!m) {
    if (["赞", "点赞", "收藏", "评论"].includes(s))
      return {
        raw: s,
        value: null,
        approximate: false,
        status: "pending",
        at: new Date().toISOString(),
      };
    return { raw: s, value: null, approximate: false, status: "failed" };
  }
  return {
    raw: s,
    value:
      Number(m[1].replace(/,/g, "")) *
      ({ 万: 1e4, 亿: 1e8, w: 1e4, k: 1e3 }[m[2].toLowerCase()] ?? 1),
    approximate: !!m[2] || s.endsWith("+"),
    status: "ready",
    at: new Date().toISOString(),
  };
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function hashFile(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export async function atomic(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(
    tmp,
    typeof data === "string" ? data : JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
  await rename(tmp, file);
}
export async function json<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function sleep(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(t);
      reject(new TaskError("CANCELLED", "任务已取消"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
export async function run(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    onData?: (s: string) => void;
  } = {},
) {
  opts.signal?.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let out = "",
      err = "",
      done = false;
    const stop = () => {
      try {
        process.kill(-p.pid!, "SIGTERM");
      } catch {
        p.kill("SIGTERM");
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish(new TaskError("TIMEOUT", "操作超时，可稍后恢复"));
    }, opts.timeout ?? 120000);
    const cancel = () => {
      stop();
      finish(new TaskError("CANCELLED", "任务已取消"));
    };
    const finish = (e?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", cancel);
      e ? reject(e) : resolve(out);
    };
    opts.signal?.addEventListener("abort", cancel, { once: true });
    p.stdout.on("data", (d) => {
      out += d;
      if (out.length > 30e6) {
        stop();
        finish(new TaskError("OUTPUT_LIMIT", "输出超过限制"));
      }
      opts.onData?.(String(d));
    });
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-50000);
    });
    p.on("error", (e) =>
      finish(
        new TaskError(
          "DEPENDENCY",
          `无法运行 ${path.basename(bin)}: ${e.message}`,
        ),
      ),
    );
    p.on("close", (code) => {
      if (code === 0) finish();
      else {
        const msg = redact(err + "\n" + out);
        const c = /usage.limit|rate.limit|quota|usage_limit/i.test(msg)
          ? "QUOTA"
          : /AUTH_REQUIRED|登录|log.?in required/i.test(msg)
            ? "AUTH_REQUIRED"
            : /SECURITY_BLOCK|验证码|安全限制|安全验证|website-login\/captcha/.test(
                  msg,
                )
              ? "SECURITY_BLOCK"
              : /BROWSER_CONNECT|daemon|extension.*connect/i.test(msg)
                ? "BROWSER_CONNECT"
                : /CONTENT_MISSING/.test(msg)
                  ? "CONTENT_MISSING"
                  : "PROCESS";
        finish(new TaskError(c, msg.slice(-4000) || `进程退出 ${code}`));
      }
    });
    p.stdin.end(opts.input ?? "");
  });
}
export function parseOutput<T>(s: string): T {
  const start = s.search(/[\[{]/);
  for (let end = s.length; end > start; end--) {
    if (!["]", "}"].includes(s[end - 1])) continue;
    try {
      return JSON.parse(s.slice(start, end));
    } catch {}
  }
  throw new TaskError("PARSE", "数据响应不是有效 JSON");
}
export function assertSelection(ids: string[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new TaskError("LIMIT", "上限必须为 1 至 100 的整数");
  if (ids.length === 0 || ids.length > limit)
    throw new TaskError("LIMIT", `请选择 1 至 ${limit} 篇笔记`);
  if (new Set(ids).size !== ids.length)
    throw new TaskError("DUPLICATE", "不能重复选择笔记");
}
export function safeName(s: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s))
    throw new TaskError(
      "NAME",
      "Skill 名称限 64 字符，使用小写字母、数字、连字符或下划线",
    );
  return s;
}

// Shared by SDK instances and the local server: one browser lease per data root.
export async function fileLease<T>(
  root: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  intervalMs = 3000,
  key = "browser",
): Promise<T> {
  const { rm, stat } = await import("node:fs/promises");
  const lock = path.join(root, `.${key}-lease`);
  await mkdir(root, { recursive: true });
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock);
      await atomic(path.join(lock, "owner.json"), {
        pid: process.pid,
        at: Date.now(),
      });
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const owner = await json<any>(path.join(lock, "owner.json"));
      let alive = true;
      if (owner?.pid) {
        try {
          process.kill(owner.pid, 0);
        } catch (e: any) {
          alive = e.code === "EPERM";
        }
      } else {
        try {
          alive = Date.now() - (await stat(lock)).mtimeMs < 30000;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await sleep(500, signal);
    }
  }
  try {
    const last = await json<any>(path.join(root, `.${key}-last.json`));
    await sleep(
      Math.max(0, intervalMs - (Date.now() - (last?.at ?? 0))),
      signal,
    );
    return await fn();
  } finally {
    await atomic(path.join(root, `.${key}-last.json`), { at: Date.now() });
    await rm(lock, { recursive: true, force: true });
  }
}

export const browserLease = fileLease;
