import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  metric,
  parseLink,
  assertSelection,
  redact,
  parseOutput,
  atomic,
  safeName,
} from "../packages/sdk/src/util.ts";
import {
  normalizeDetail,
  normalizeCard,
  Acquisition,
} from "../packages/sdk/src/providers.ts";
import { Store } from "../packages/sdk/src/store.ts";
import { Distiller, config } from "../packages/sdk/src/index.ts";
import { parseSrt, validateEvidence } from "../packages/sdk/src/media.ts";
import { makeZip, resolveMaterialIssues } from "../packages/sdk/src/export.ts";
const id = "0000000000000000000000aa",
  url = `https://www.xiaohongshu.com/explore/${id}?xsec_token=test`;
test("metrics preserve null, zero, abbreviated counts and unknown text", () => {
  assert.equal(metric(null).value, null);
  assert.equal(metric(0).value, 0);
  assert.equal(metric("收藏").value, null);
  assert.deepEqual(
    [metric("1.2万").value, metric("1.2万").approximate],
    [12000, true],
  );
  assert.equal(metric("unknown").status, "failed");
  assert.equal(metric("1,203").value, 1203);
});
test("links enforce exact domain, path and de-escaped share parameters", () => {
  assert.equal(parseLink(url).id, id);
  assert.equal(
    new URL(
      parseLink(
        url.replace("xsec_token", "xsec\\_token") + "\\&xsec_source=app_share",
      ).url,
    ).searchParams.get("xsec_token"),
    "test",
  );
  assert.equal(parseLink(url.replace("&", "\\&")).id, id);
  assert.throws(() =>
    parseLink("https://xiaohongshu.com.evil.test/explore/" + id),
  );
  assert.throws(() => parseLink("file:///tmp/a"));
  assert.throws(() => parseLink("http://127.0.0.1/"));
});
test("selection boundary and user requested underscore skill name", () => {
  assertSelection(
    Array.from({ length: 10 }, (_, i) => String(i)),
    10,
  );
  assert.throws(() =>
    assertSelection(
      Array.from({ length: 11 }, (_, i) => String(i)),
      10,
    ),
  );
  assertSelection(
    Array.from({ length: 16 }, (_, i) => String(i)),
    16,
  );
  assert.throws(() => assertSelection(["a", "a"], 10));
  assert.equal(safeName("creator_advisor"), "creator_advisor");
  assert.throws(() => safeName("../escape"));
});
test("structured detail retains image order, missing metrics and alternate video codecs", () => {
  assert.throws(() => normalizeCard({ id: "../escape" }));
  const x = normalizeDetail(
    {
      detail: {
        noteId: id,
        title: "测试",
        desc: "",
        type: "video",
        user: { nickname: "作者" },
        imageList: [
          { urlDefault: "https://a.xhscdn.com/2" },
          { urlDefault: "https://a.xhscdn.com/1" },
        ],
        video: {
          media: {
            stream: { EF4: [{ masterUrl: "https://a.xhscdn.com/v.mp4" }] },
          },
        },
      },
    },
    url,
  );
  assert.equal(x.media[0].type, "video");
  assert.equal(x.media[1].url, "https://a.xhscdn.com/2");
  assert.equal(x.note.collects.value, null);
  assert.equal(x.bodyStatus, "ready");
  assert.throws(() =>
    normalizeDetail({ detail: { noteId: id, type: "video", desc: "" } }, url),
  );
});
test("subtitles preserve timed segments and multiline speech", () => {
  const x = parseSrt(
    "1\n00:01:02,300 --> 00:01:05,040\n我们需要\n验证需求\n\n2\n00:02:00,000 --> 00:02:03,000\n下一步",
  );
  assert.equal(x.length, 2);
  assert.equal(x[0].start, 62.3);
  assert.equal(x[0].end, 65.04);
  assert.equal(x[0].text, "我们需要 验证需求");
});
test("material issues require an exact, evidenced review before they stop blocking", () => {
  const issue = {
    location: "audio-3",
    message: "局部转写缺失",
    critical: true,
  };
  const review = {
    location: "audio-3",
    message: "局部转写缺失",
    reason: "已用独立局部转写恢复",
    evidence: ["gap-check.srt"],
    reviewedAt: "2026-09-08T00:00:00.000Z",
  };
  assert.equal(resolveMaterialIssues(id, [issue], []).unresolved.length, 1);
  assert.equal(
    resolveMaterialIssues(id, [issue], [{ ...review, message: "另一疑点" }])
      .unresolved.length,
    1,
  );
  const resolved = resolveMaterialIssues(id, [issue], [review]);
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.resolved[0].noteId, id);
});
test("evidence cannot refer to nonexistent sources or fabricated quotes", () => {
  const m: any = {
    id: id + "-m1",
    title: "判断",
    level: "explicit",
    evidence: [{ noteId: id, segmentId: "body", quote: "需求" }],
  };
  const n: any = [{ id, segments: [{ id: "body", text: "先验证需求" }] }];
  validateEvidence([m], n);
  assert.throws(() =>
    validateEvidence(
      [
        {
          ...m,
          evidence: [{ noteId: id, segmentId: "body", quote: "保证融资" }],
        },
      ],
      n,
    ),
  );
  assert.throws(() => validateEvidence([{ ...m, evidence: [] }], n));
});
test("persistence recovers dead workers but never pauses another live worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-store-"));
  const s = new Store(root);
  s.put("job", { id: "dead", status: "running", ownerPid: 2147483647 } as any);
  s.put("job", { id: "live", status: "running", ownerPid: process.pid } as any);
  s.recover();
  assert.equal(s.get<any>("job", "dead").status, "paused");
  assert.equal(s.get<any>("job", "live").status, "running");
  s.close();
});
test("SDK imports deduplicated links and enforces limits server-side", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-sdk-"));
  const sdk = new Distiller(config(root));
  const p = sdk.createProject();
  await sdk.importNoteLinks(p.id, [url, url]);
  assert.equal(sdk.store.project(p.id).notes.length, 1);
  assert.throws(() => sdk.updateProject(p.id, { selected: ["missing"] }));
  sdk.updateProject(p.id, { selected: [id], skillName: "creator_advisor" });
  assert.equal(sdk.store.project(p.id).skillName, "creator_advisor");
  sdk.store.close();
});
test("provider serializes requests even when callers run concurrently", async () => {
  let active = 0,
    max = 0;
  const provider: any = {
    name: "test",
    detail: async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 8));
      active--;
      return {};
    },
  };
  const a = new Acquisition(config("/tmp", { requestIntervalMs: 0 }), provider);
  await Promise.all([a.detail(url), a.detail(url), a.detail(url)]);
  assert.equal(max, 1);
});
test("complete empty list stays distinct from stalled enumeration and deduplicates many pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-pages-"));
  const provider: any = {
    name: "test",
    detail: async (u: string) =>
      normalizeDetail(
        {
          detail: {
            noteId: parseLink(u).id,
            title: "详情标题",
            desc: "内容",
            type: "normal",
            imageList: [],
            interactInfo: { collectedCount: "23" },
          },
        },
        u,
      ),
    scan: async (_u: any, cb: any) => {
      for (let page = 0; page < 7; page++)
        cb(
          [
            normalizeCard({ id, title: "置顶" }),
            normalizeCard({
              id: page.toString().padStart(24, "0"),
              title: String(page),
            }),
          ],
          false,
        );
      return { complete: false, reason: "stalled" };
    },
  };
  const sdk = new Distiller(config(root, { requestIntervalMs: 0, contextBuildEnabled: false }), provider);
  const p = sdk.createProject();
  await sdk.listAuthorNotes(
    p.id,
    "https://www.xiaohongshu.com/user/profile/" + id,
  );
  await sdk.tasks.get("scan:" + p.id);
  assert.equal(sdk.store.project(p.id).notes.length, 8);
  assert.equal(sdk.store.project(p.id).scan.complete, false);
  assert.equal(sdk.store.project(p.id).scan.status, "paused");
  await sdk.tasks.get("metadata:" + p.id);
  assert.equal(sdk.store.project(p.id).notes[0].collects.value, 23);
  await sdk.close();
});
test("export rejects tokens and includes a real zip signature", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-zip-"));
  await writeFile(path.join(root, "SKILL.md"), "name: safe");
  await makeZip(root, root + ".zip");
  assert.equal((await readFile(root + ".zip")).subarray(0, 2).toString(), "PK");
  await writeFile(path.join(root, "bad.md"), url);
  await assert.rejects(() => makeZip(root, root + ".zip"));
  assert.ok(!redact(url).includes("=test"));
});
test("no stdout progress preamble leaks into JSON parsing", () => {
  assert.deepEqual(parseOutput('hello\n[{"ok":true}]\nupdate available'), [
    { ok: true },
  ]);
});
test("pure text notes with explicit empty media list remain valid", () => {
  const d = normalizeDetail(
    {
      detail: {
        noteId: id,
        type: "normal",
        imageList: [],
        desc: "文字正文",
        title: "纯文字",
      },
    },
    url,
  );
  assert.equal(d.note.type, "text");
  assert.equal(d.media.length, 0);
});
test("cancelling a model subprocess rejects promptly", async () => {
  const { run } = await import("../packages/sdk/src/util.ts");
  const c = new AbortController();
  const p = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: c.signal,
    timeout: 5000,
  });
  setTimeout(() => c.abort(), 25);
  await assert.rejects(p, (e: any) => e.code === "CANCELLED");
});
test("scan cancellation preserves discovered pages and keeps incomplete status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-cancel-"));
  const provider: any = {
    name: "test",
    scan: async (_u: any, cb: any, signal: AbortSignal) => {
      cb([normalizeCard({ id, title: "已读取" })], false);
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      );
    },
  };
  const sdk = new Distiller(config(root, { requestIntervalMs: 0 }), provider);
  const p = sdk.createProject();
  await sdk.listAuthorNotes(
    p.id,
    "https://www.xiaohongshu.com/user/profile/" + id,
  );
  await new Promise((r) => setTimeout(r, 30));
  sdk.cancelScan(p.id);
  await sdk.tasks.get("scan:" + p.id);
  assert.equal(sdk.store.project(p.id).notes.length, 1);
  assert.equal(sdk.store.project(p.id).scan.complete, false);
  sdk.store.close();
});
test("model-produced paths and shell substitution strings cannot become output filenames", () => {
  assert.throws(() => safeName("$(touch bad)"));
  assert.throws(() => safeName("a/b"));
  assert.throws(() => safeName("a\\b"));
});
test("full job writes source-backed skill and actual behavioral comparison, then can export", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-e2e-"));
  const note = normalizeDetail(
    {
      detail: {
        noteId: id,
        title: "需求验证",
        desc: "先访谈客户，再验证付费意愿。",
        type: "normal",
        imageList: [],
        user: { nickname: "测试作者" },
      },
    },
    url,
  );
  const provider: any = { name: "fixture", detail: async () => note };
  const sdk = new Distiller(config(root, { requestIntervalMs: 0, contextBuildEnabled: false }), provider);
  const p = sdk.createProject("测试项目", "test_advisor");
  await sdk.importNoteLinks(p.id, [url]);
  sdk.updateProject(p.id, { selected: [id] });
  const m: any = {
    id: id + "-m1",
    title: "验证需求",
    problem: "不确定是否需要",
    conditions: ["早期"],
    questions: ["客户是谁"],
    steps: ["访谈"],
    actions: ["记录证据"],
    exceptions: ["不是融资保证"],
    level: "explicit",
    evidence: [{ noteId: id, segmentId: "body", quote: "先访谈客户" }],
  };
  sdk.cleaner = {
    clean: async (_r: any, dir: string) => {
      const a = {
        clean: {
          version: 1,
          id,
          title: "需求验证",
          segments: [{ id: "body", kind: "body", text: note.body }],
          cleanText: note.body,
          issues: [],
          corrections: [],
          inputHash: "x",
          processorVersion: "fixture",
        },
        methods: [m],
        style: ["直接"],
      };
      await atomic(path.join(dir, "analysis.json"), a);
      return a;
    },
  } as any;
  const calls: string[] = [];
  sdk.model = {
    call: async (_dir: any, label: string) => {
      calls.push(label);
      if (label === "synthesis")
        return {
          description: "需求验证顾问",
          principles: ["依据访谈"],
          style: ["直接"],
          conflicts: [],
          workflows: [
            {
              name: "诊断",
              triggers: ["需求"],
              instructions: ["访谈"],
              methodIds: [m.id],
              output: "证据清单",
            },
          ],
          examples: Array.from({ length: 3 }, (_, i) => ({
            request: "假设案例" + i,
            response: "先验证需求",
            methodIds: [m.id],
          })),
          limits: ["测试材料"],
        };
      if (label === "test-cases")
        return {
          cases: Array.from({ length: 8 }, (_, i) => ({
            name: "case" + i,
            prompt: "请验证需求",
          })),
        };
      if (label === "baseline" || label === "candidate")
        return {
          responses: Array.from({ length: 8 }, (_, i) => ({
            name: "case" + i,
            answer: label + " actual " + i,
          })),
        };
      if (label === "evaluation-judge")
        return {
          cases: Array.from({ length: 8 }, (_, i) => ({
            name: "case" + i,
            prompt: "请验证需求",
            baseline: "judge must not replace",
            withSkill: "judge must not replace",
            methodIds: [m.id],
            baselineFaithfulness: 2,
            baselineQuestionQuality: 2,
            baselineCompletion: 3,
            faithfulness: 4,
            questionQuality: 4,
            completion: 4,
            passed: true,
            reason: "测试",
          })),
          issues: [],
        };
      throw new Error(label);
    },
  } as any;
  const j = sdk.startDistillation(p.id);
  const finished = await sdk.waitJob(j.id);
  assert.equal(finished.status, "complete", finished.error);
  assert.ok(
    calls.includes("baseline") &&
      calls.includes("candidate") &&
      calls.includes("evaluation-judge"),
  );
  const report = JSON.parse(
    await readFile(path.join(finished.output!, "quality.json"), "utf8"),
  );
  assert.equal(
    report.behavioralEvaluation.cases[0].baseline,
    "baseline actual 0",
  );
  assert.equal(
    report.behavioralEvaluation.cases[0].withSkill,
    "candidate actual 0",
  );
  assert.match(
    await readFile(
      path.join(finished.output!, "skill/test_advisor/SKILL.md"),
      "utf8",
    ),
    /name: test_advisor/,
  );
  assert.ok((await sdk.exportBundle(j.id)).endsWith(".zip"));
  sdk.store.close();
});

test("SQLite project mutations roll back and preserve changes from another connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-store-"));
  const sdk = new Distiller(config(root));
  const p = sdk.createProject("one");
  const other = new Store(sdk.cfg.dataDir);
  assert.throws(() =>
    other.mutateProject(p.id, (p) => {
      p.name = "invalid";
      throw Error("stop");
    }),
  );
  assert.equal(sdk.store.project(p.id).name, "one");
  other.mutateProject(p.id, (p) => {
    p.purpose = "keep me";
  });
  sdk.updateProject(p.id, { name: "two" });
  assert.equal(other.project(p.id).purpose, "keep me");
  other.close();
  sdk.store.close();
});

test("optional API is gated and normalizes explicit pagination end without invented metrics", async () => {
  const { GuaikeiProvider } = await import("../packages/sdk/src/providers.ts");
  const disabled = new GuaikeiProvider(false);
  await assert.rejects(disabled.request("detail/info", {}), /未启用|密钥/);
  const provider = new GuaikeiProvider(true);
  let finished: boolean | undefined;
  let notes: any[] = [];
  provider.task = async () => ({
    results: [{ id, title: "真实标题", liked_count: "1.2万" }],
    has_more: false,
  });
  await provider.scan(
    "https://www.xiaohongshu.com/user/profile/5eb53b070000000001001a6a",
    (n, c) => {
      notes = n;
      finished = c;
    },
  );
  assert.equal(finished, true);
  assert.equal(notes[0].likes.value, 12000);
  assert.equal(notes[0].collects.value, null);
  assert.equal(notes[0].source, "guaikei");
  provider.task = async () => ({ results: [] });
  const stalled = await provider.scan(
    "https://www.xiaohongshu.com/user/profile/5eb53b070000000001001a6a",
    () => {},
  );
  assert.equal(stalled.complete, false);
});

test("offline recovery never reacquires missing or corrupt local media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-offline-"));
  let calls = 0;
  const sdk = new Distiller(config(root, { requestIntervalMs: 0 }), {
    name: "fixture",
    detail: async () => {
      calls++;
      throw Error("must not request");
    },
  } as any);
  const p = sdk.createProject("offline");
  await sdk.importNoteLinks(p.id, [url]);
  sdk.updateProject(p.id, { selected: [id] });
  const raw = normalizeDetail(
    {
      detail: {
        noteId: id,
        title: "text",
        desc: "raw",
        type: "normal",
        imageList: [],
      },
    },
    url,
  );
  raw.media = [
    {
      type: "image",
      url: "https://a.xhscdn.com/image",
      path: path.join(root, "absent.jpg"),
      sha256: "invalid",
    },
  ];
  await atomic(
    path.join(sdk.cfg.dataDir, "projects", p.id, "notes", id, "raw.json"),
    raw,
  );
  const { randomUUID } = await import("node:crypto");
  const jid = randomUUID();
  sdk.store.put("job", {
    id: jid,
    projectId: p.id,
    skillName: p.skillName,
    purpose: "",
    selected: [id],
    status: "paused",
    stage: "",
    noteStates: {
      [id]: { fetch: "complete", clean: "complete", extract: "complete" },
    },
  } as any);
  sdk.resumeJob(jid, { offline: true });
  const job = await sdk.waitJob(jid);
  assert.equal(calls, 0);
  assert.equal(job.status, "paused");
  assert.equal(job.noteStates[id].extract, "pending");
  sdk.store.close();
});

test("model output is checked against the complete JSON schema", async () => {
  const { validateModelOutput, obj } =
    await import("../packages/sdk/src/model.ts");
  const schema = obj({ score: { type: "integer", minimum: 0, maximum: 5 } });
  validateModelOutput(schema, { score: 0 });
  assert.throws(() => validateModelOutput(schema, { score: 6 }));
  assert.throws(() => validateModelOutput(schema, {}));
  assert.throws(() =>
    validateModelOutput(schema, { score: 2, command: "write file" }),
  );
});

test("expired note links refresh from the author without importing unrelated notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-refresh-"));
  const refreshed = url.replace("=test", "=fresh");
  const { TaskError } = await import("../packages/sdk/src/util.ts");
  const provider: any = {
    name: "fixture",
    detail: async (u: string) => {
      if (u === url) throw new TaskError("CONTENT_MISSING", "expired");
      assert.equal(u, refreshed);
      return normalizeDetail(
        {
          detail: {
            noteId: id,
            title: "refreshed",
            desc: "body",
            type: "normal",
            imageList: [],
          },
        },
        u,
      );
    },
    scan: async (_u: string, cb: any) => {
      cb(
        [
          normalizeCard({ id, url: refreshed }),
          normalizeCard({ id: "000000000000000000000000" }),
        ],
        false,
      );
      return { complete: false };
    },
  };
  const sdk = new Distiller(config(root, { requestIntervalMs: 0 }), provider);
  const p = sdk.createProject("refresh");
  await sdk.importNoteLinks(p.id, [url]);
  sdk.store.mutateProject(p.id, (p) => {
    p.scan.url =
      "https://www.xiaohongshu.com/user/profile/5eb53b070000000001001a6a";
  });
  await sdk.fetchNote(p.id, id);
  const after = sdk.store.project(p.id);
  assert.equal(after.notes.length, 1);
  assert.equal(after.notes[0].url, refreshed);
  assert.equal(after.notes[0].originalUrl, url);
  await sdk.close();
});

test("transcript bounds expose ASR hallucinated timestamps instead of silent success", async () => {
  const { transcriptIssues } = await import("../packages/sdk/src/media.ts");
  const audio: any[] = [
    { id: "a", kind: "audio", start: 0, end: 10, text: "valid" },
    { id: "b", kind: "audio", start: 10, end: 40, text: "invalid" },
  ];
  assert.deepEqual(
    transcriptIssues(audio, 12).map((i) => i.location),
    ["b"],
  );
  assert.equal(transcriptIssues(audio, 50).length, 0);
});

test("evidence spanning OCR line breaks preserves exact source characters without fuzzy claims", async () => {
  const { exactWhitespaceSpan } = await import("../packages/sdk/src/media.ts");
  assert.equal(
    exactWhitespaceSpan("资\n金将用于增长", "资金将用于增长"),
    "资\n金将用于增长",
  );
  assert.equal(exactWhitespaceSpan("资金增长 13%", "资金增长 83%"), null);
  const method: any = {
    id: id + "-m1",
    title: "预算",
    level: "explicit",
    evidence: [{ noteId: id, segmentId: "image-1", quote: "资金将用于增长" }],
  };
  validateEvidence(
    [method],
    [
      {
        id,
        segments: [{ id: "image-1", kind: "image", text: "资\n金将用于增长" }],
      },
    ],
  );
  assert.equal(method.evidence[0].quote, "资\n金将用于增长");
});

test("evidence can cite a verified visual correction tied to the same segment", () => {
  const method: any = {
    id: id + "-m1",
    title: "竞争力",
    level: "explicit",
    evidence: [{ noteId: id, segmentId: "frame-45", quote: "竞争力突出" }],
  };
  const notes: any = [
    {
      id,
      segments: [
        {
          id: "frame-45",
          kind: "frame",
          text: "2心竟争力突出",
          evidenceText: ["纠正：核心竞争力突出"],
        },
      ],
    },
  ];
  validateEvidence([method], notes);
  assert.equal(method.evidence[0].quote, "竞争力突出");
  assert.throws(() =>
    validateEvidence(
      [
        {
          ...method,
          evidence: [{ noteId: id, segmentId: "frame-45", quote: "市场第一" }],
        },
      ],
      notes,
    ),
  );
});

test("interleaved table OCR is repaired from the image and recovery reuses validated results", async () => {
  const { Cleaner } = await import("../packages/sdk/src/media.ts");
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-layout-"));
  const imagePath = path.join(root, "fixture.jpg");
  await writeFile(imagePath, "fixture bytes");
  const segments: any[] = [
    {
      id: "image-1",
      kind: "image",
      page: 1,
      imagePath,
      text: "资\n其他列\n金",
    },
  ];
  const calls: string[] = [];
  const model: any = {
    call: async (_dir: any, label: string) => {
      calls.push(label);
      if (label === "visual-0")
        return {
          observations: [
            { segmentId: "image-1", text: "表格跨列", uncertainty: "" },
          ],
        };
      if (label === "analysis")
        return {
          cleanText: "",
          methods: [{
            id: id + "-m1",
            title: "表格阅读",
            problem: "区分相邻列",
            conditions: [], questions: [], steps: [], actions: [], exceptions: [],
            level: "explicit",
            evidence: [{ noteId: id, segmentId: "image-1", quote: "表格跨列" }],
          }],
          style: [],
          issues: [],
          corrections: [
            {
              location: "image-1",
              before: "资金",
              after: "资金",
              reason: "顺序",
            },
          ],
        };
      if (label === "layout-image-1")
        return {
          text: "| 第一列 | 第二列 |\n|---|---|\n| 资金 | 其他列 |",
          issues: [],
        };
      throw Error(label);
    },
  };
  const cleaner = new Cleaner(config(root), model);
  cleaner.prepare = async () => segments;
  const raw = normalizeDetail(
    {
      detail: {
        noteId: id,
        title: "表格",
        desc: "",
        type: "normal",
        imageList: [],
      },
    },
    url,
  );
  const first = await cleaner.clean(raw, root);
  assert.equal(first.clean.issues.length, 0);
  assert.match(first.clean.cleanText, /资金 \| 其他列/);
  assert.equal(first.clean.corrections[0].before, segments[0].text);
  const file = path.join(root, "analysis.json");
  const old = JSON.parse(await readFile(file, "utf8"));
  validateEvidence(old.methods, [old.clean]);
  delete old.clean.segments[0].evidenceText;
  await atomic(file, old);
  const repaired = await cleaner.clean(raw, root);
  validateEvidence(repaired.methods, [repaired.clean]);
  assert.deepEqual(repaired.clean.segments[0].evidenceText, ["表格跨列"]);

  const jobRoot = path.join(root, "projects", "project", "jobs", "job");
  await atomic(path.join(jobRoot, "methods.json"), repaired.methods);
  await atomic(path.join(jobRoot, "sources", id + ".json"), repaired.clean);
  const { migrateLegacyJob } = await import("../packages/sdk/src/context/migrate.ts");
  const pkg = await migrateLegacyJob({ dataDir: root, projectId: "project", jobId: "job", contextId: "fixture" });
  const unit = pkg.evidenceUnits.find(e => e.id === pkg.claims[0].evidenceIds[0]);
  assert.match(unit!.text, /画面复核：表格跨列/);
  assert.equal(unit?.locator.page, 1);

  await rm(file);
  await cleaner.clean(raw, root);
  assert.deepEqual(calls, ["visual-0", "analysis", "layout-image-1"]);
});
