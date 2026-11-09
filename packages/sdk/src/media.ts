import path from "node:path";
import { mkdir, readFile, readdir, stat, rm } from "node:fs/promises";
import {
  atomic,
  hash,
  hashFile,
  fileLease,
  json,
  run,
  TaskError,
} from "./util.ts";
import type { Config, RawNote, Segment, CleanNote, Method } from "./types.ts";
import { ModelRunner, analysisSchema } from "./model.ts";
export const PROCESSOR_VERSION = "1.0.0";
export function parseSrt(text: string): Segment[] {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .flatMap((block, i) => {
      const lines = block.split(/\r?\n/);
      const at = lines.findIndex((l) => l.includes("-->"));
      if (at < 0) return [];
      const times = lines[at].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g);
      if (!times || times.length < 2) return [];
      const sec = (t: string) => {
        const [h, m, s, ms] = t.split(/[:,.]/).map(Number);
        return h * 3600 + m * 60 + s + ms / 1000;
      };
      return [
        {
          id: "audio-" + (i + 1),
          kind: "audio" as const,
          start: sec(times[0]),
          end: sec(times[1]),
          text: lines.slice(at + 1).join(" "),
        },
      ];
    });
}
export function exactWhitespaceSpan(
  text: string,
  quote: string,
): string | null {
  if (text.includes(quote)) return quote;
  const positions: number[] = [];
  let compact = "";
  for (let i = 0; i < text.length; i++)
    if (!/\s/.test(text[i])) {
      compact += text[i];
      positions.push(i);
    }
  const target = quote.replace(/\s/g, "");
  if (!target) return null;
  const at = compact.indexOf(target);
  return at < 0
    ? null
    : text.slice(positions[at], positions[at + target.length - 1] + 1);
}
export function validateEvidence(
  methods: Method[],
  notes: {
    id: string;
    segments: Segment[];
  }[],
) {
  const map = new Map(
    notes.map((n) => [n.id, new Map(n.segments.map((s) => [s.id, s]))]),
  );
  const methodIds = new Set<string>();
  for (const m of methods) {
    if (!/^[a-f0-9]{24}-m[0-9]+$/.test(m.id) || methodIds.has(m.id))
      throw new TaskError("EVIDENCE", "方法编号无效或重复");
    methodIds.add(m.id);
    if (m.level !== "external" && !m.evidence.length)
      throw new TaskError("EVIDENCE", `方法「${m.title}」缺少依据`);
    for (const e of m.evidence) {
      const segment = map.get(e.noteId)?.get(e.segmentId);
      if (!segment)
        throw new TaskError("EVIDENCE", `方法「${m.title}」引用无法回溯`);
      if (e.quote) {
        const exact = [segment.text, ...(segment.evidenceText ?? [])]
          .map((text) => exactWhitespaceSpan(text, e.quote))
          .find((text) => text !== null);
        if (exact === undefined)
          throw new TaskError("EVIDENCE", `方法「${m.title}」引用无法回溯`);
        e.quote = exact;
      }
    }
  }
}
export function transcriptIssues(segments: Segment[], duration: number) {
  return segments
    .filter(
      (s) =>
        s.kind === "audio" &&
        (s.start === undefined ||
          s.end === undefined ||
          s.start < 0 ||
          s.end <= s.start ||
          s.start >= duration ||
          s.end > duration + 0.5),
    )
    .map((s) => ({
      location: s.id,
      message: `ASR 时间戳超出或不符合实际音轨（${duration.toFixed(2)}秒），需复核；原转写保留，不能据此补写内容。`,
      critical: true,
    }));
}
export class Cleaner {
  constructor(
    private cfg: Config,
    private model: ModelRunner,
  ) {}
  async ocr(files: string[], signal?: AbortSignal) {
    if (!files.length) return [];
    return JSON.parse(
      await run(this.cfg.visionBin, files, { signal, timeout: 180000 }),
    ) as {
      file: string;
      lines: { text: string; confidence: number; box: number[] }[];
      error?: string;
    }[];
  }
  async prepare(
    raw: RawNote,
    dir: string,
    signal?: AbortSignal,
  ): Promise<Segment[]> {
    const checkpoint = path.join(dir, "segments.json");
    const digest = hash(
      JSON.stringify({
        body: raw.body,
        media: raw.media.map((m) => m.sha256),
        ...(raw.subtitles?.length ? { subtitles: raw.subtitles } : {}),
        version: PROCESSOR_VERSION,
      }),
    );
    const old = await json<any>(checkpoint);
    if (old?.digest === digest) return old.segments;
    const segments: Segment[] = [];
    if (raw.body !== null)
      segments.push({ id: "body", kind: "body", text: raw.body });
    for (let index = 0; index < (raw.subtitles?.length || 0); index++) {
      const sub = raw.subtitles![index];
      const cues = sub.cues.length
        ? sub.cues
        : sub.path
          ? parseSrt(
              (await readFile(sub.path, "utf8")).replace(
                /^(\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}\.\d{3})/gm,
                "00:$1 --> 00:$2",
              ),
            )
          : [];
      if (!cues.length)
        throw new TaskError("SUBTITLE", "字幕轨存在但未能提取文字");
      for (let i = 0; i < cues.length; i++)
        segments.push({
          id: `subtitle-${index + 1}-${i + 1}`,
          kind: "subtitle",
          start: cues[i].start,
          end: cues[i].end,
          text: cues[i].text,
        });
    }
    const images = raw.media.filter((m) => m.type === "image");
    for (const im of images) {
      if (!im.path) throw new TaskError("MEDIA", "图像尚未下载");
      const [r] = await this.ocr([im.path], signal);
      if (r.error) throw new TaskError("OCR", r.error);
      segments.push({
        id: `image-${im.page}`,
        kind: "image",
        page: im.page,
        imagePath: im.path,
        text: r.lines.map((l) => l.text).join("\n"),
        confidence: r.lines.length
          ? Math.min(...r.lines.map((l) => l.confidence))
          : 0,
        boxes: r.lines.map((l) => ({ text: l.text, box: l.box })),
      });
    }
    const video = raw.media.find((m) => m.type === "video");
    if (video) {
      if (!video.path) throw new TaskError("MEDIA", "视频尚未下载");
      const wav = path.join(dir, "audio.wav"),
        prefix = path.join(dir, "transcript");
      try {
        if ((await json<any>(wav + ".complete"))?.sourceHash !== video.sha256)
          throw new Error("stale audio");
        await stat(wav);
      } catch {
        await run(
          this.cfg.ffmpegBin,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            video.path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            wav,
          ],
          { signal, timeout: 600000 },
        );
        await atomic(wav + ".complete", {
          complete: true,
          sourceHash: video.sha256,
        });
      }
      try {
        const checkpoint = await json<any>(prefix + ".complete");
        if (
          checkpoint?.sourceHash !== video.sha256 ||
          checkpoint?.model !== this.cfg.whisperModel
        )
          throw new Error("stale transcript");
        await stat(prefix + ".srt");
      } catch {
        await run(
          this.cfg.whisperBin,
          [
            "-m",
            this.cfg.whisperModel,
            "-f",
            wav,
            "-l",
            "zh",
            "-osrt",
            "-oj",
            "-of",
            prefix,
            "-np",
          ],
          { signal, timeout: 7200000 },
        );
        await atomic(prefix + ".complete", {
          complete: true,
          sourceHash: video.sha256,
          model: this.cfg.whisperModel,
        });
      }
      const audio = parseSrt(await readFile(prefix + ".srt", "utf8"));
      if (!audio.length)
        throw new TaskError(
          "ASR_EMPTY",
          "没有识别出有效口播；需要确认视频是否静音",
        );
      segments.push(...audio);
      const frames = path.join(dir, "frames");
      await mkdir(frames, { recursive: true });
      if (
        (await json<any>(path.join(frames, "complete.json")))?.sourceHash !==
        video.sha256
      ) {
        await rm(frames, { recursive: true, force: true });
        await mkdir(frames, { recursive: true });
        await run(
          this.cfg.ffmpegBin,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            video.path,
            "-vf",
            "select='isnan(prev_selected_t)+gte(t-prev_selected_t,15)+gt(scene,0.35)',scale=960:-2,showinfo",
            "-fps_mode",
            "vfr",
            "-enc_time_base",
            "1:1000",
            "-frame_pts",
            "1",
            path.join(frames, "frame-%010d.jpg"),
          ],
          { signal, timeout: 900000 },
        );
        await atomic(path.join(frames, "complete.json"), {
          complete: true,
          sourceHash: video.sha256,
        });
      }
      const frameFiles = (await readdir(frames))
        .filter((f) => f.endsWith(".jpg"))
        .sort();
      const seenFrames = new Set<string>();
      for (let i = 0; i < frameFiles.length; i++) {
        signal?.throwIfAborted();
        const file = path.join(frames, frameFiles[i]);
        const frameHash = await hashFile(file);
        if (seenFrames.has(frameHash)) continue;
        seenFrames.add(frameHash);
        const [r] = await this.ocr([file], signal);
        if (r.error) throw new TaskError("OCR", r.error);
        const text = r.lines.map((l) => l.text).join("\n");
        segments.push({
          id: "frame-" + (i + 1),
          kind: "frame",
          start: Number(frameFiles[i].match(/frame-(\d+)/)?.[1] ?? 0) / 1000,
          text,
          imagePath: file,
          confidence: r.lines.length
            ? Math.min(...r.lines.map((l) => l.confidence))
            : 0,
          boxes: r.lines.map((l) => ({ text: l.text, box: l.box })),
        });
      }
    }
    await atomic(checkpoint, { digest, segments });
    return segments;
  }
  async clean(
    raw: RawNote,
    dir: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ clean: CleanNote; methods: Method[]; style: string[] }> {
    return fileLease(
      dir,
      () => this.cleanLocked(raw, dir, signal, onProgress),
      signal,
      0,
      "processing",
    );
  }
  private async cleanLocked(
    raw: RawNote,
    dir: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ clean: CleanNote; methods: Method[]; style: string[] }> {
    onProgress?.("提取正文、OCR 与音频转写");
    const segments = await this.prepare(raw, dir, signal);
    const inputHash = hash(JSON.stringify(segments) + PROCESSOR_VERSION);
    let timingIssues: {
      location: string;
      message: string;
      critical: boolean;
    }[] = [];
    if (raw.media.some((m) => m.type === "video")) {
      const probe = this.cfg.ffmpegBin.includes("/")
        ? path.join(path.dirname(this.cfg.ffmpegBin), "ffprobe")
        : "ffprobe";
      const duration = Number(
        (
          await run(
            probe,
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              path.join(dir, "audio.wav"),
            ],
            { signal },
          )
        ).trim(),
      );
      if (!Number.isFinite(duration) || duration <= 0)
        throw new TaskError("ASR", "无法验证音轨时长");
      timingIssues = transcriptIssues(segments, duration);
      await atomic(path.join(dir, "transcript-quality.json"), {
        duration,
        issues: timingIssues,
      });
    }
    const old = await json<any>(path.join(dir, "analysis.json"));
    const restoreAnalysis = async (groundedSegments: Segment[]) => {
      if (old?.clean?.inputHash !== inputHash) return null;
      try {
        validateEvidence(old.methods, [{ id: raw.note.id, segments: groundedSegments }]);
      } catch (error) {
        if (error instanceof TaskError && error.code === "EVIDENCE") return null;
        throw error;
      }
      old.clean.segments = groundedSegments;
      for (const issue of timingIssues)
        if (
          !old.clean.issues.some(
            (i: any) =>
              i.message === issue.message && i.location === issue.location,
          )
        )
          old.clean.issues.push(issue);
      await atomic(path.join(dir, "analysis.json"), old);
      return old;
    };
    const restored = await restoreAnalysis(old?.clean?.segments ?? segments);
    if (restored) return restored;
    // Every image/frame is reviewed in bounded visual batches before overall text analysis.
    const visuals = segments.filter((s) => s.imagePath);
    const visualNotes: string[] = [];
    const visualEvidence = new Map<string, string[]>();
    for (let start = 0; start < visuals.length; start += 8) {
      const batch = visuals.slice(start, start + 8);
      onProgress?.(
        `核对图片与画面 ${start + 1}–${Math.min(start + 8, visuals.length)}/${visuals.length}`,
      );
      const key = "visual-" + start;
      const visualHash = hash(
        JSON.stringify(
          await Promise.all(
            batch.map(async (s) => ({
              id: s.id,
              text: s.text,
              imageHash: await hashFile(s.imagePath!),
            })),
          ),
        ),
      );
      let result = await json<any>(path.join(dir, key + ".verified.json"));
      if (result?.inputHash !== visualHash) result = null;
      const checkObservations = (value: any) => {
        if (!Array.isArray(value.observations) || value.observations.length !== batch.length ||
            new Set(value.observations.map((ob: any) => ob.segmentId)).size !== batch.length ||
            value.observations.some((ob: any) => !batch.some(segment => segment.id === ob.segmentId)))
          throw new TaskError("MODEL_OUTPUT", "视觉核对必须且只能覆盖每张指定图片一次");
      };
      if (result) {
        try { checkObservations(result); } catch { result = null; }
      }
      if (!result) {
        result = await this.model.call<any>(
          dir,
          key,
          "核对下列图片的OCR，提取遗漏的表格和图示关系及关键数字。不要重复已有OCR，不要转写无关装饰。text仅返回需要纠正的句子或OCR遗漏的信息；每张最多200字，无补充则空字符串。当前只是部分图片，不得基于本批次判断整篇缺项、总页数或总分错误。按每张图的segmentId返回，标明不可辨读部分。\n" +
            JSON.stringify(batch.map(({ id, text }) => ({ id, text }))),
          {
            type: "object",
            properties: {
              observations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    segmentId: { type: "string" },
                    text: { type: "string" },
                    uncertainty: { type: "string" },
                  },
                  required: ["segmentId", "text", "uncertainty"],
                  additionalProperties: false,
                },
              },
            },
            required: ["observations"],
            additionalProperties: false,
          },
          signal,
          batch.map((s) => s.imagePath!),
          checkObservations,
        );
        checkObservations(result);
        result.inputHash = visualHash;
        await atomic(path.join(dir, key + ".verified.json"), result);
      }
      for (const ob of result.observations ?? []) {
        visualNotes.push(JSON.stringify(ob));
        if (String(ob.text ?? "").trim()) {
          const values = visualEvidence.get(ob.segmentId) ?? [];
          values.push(String(ob.text));
          visualEvidence.set(ob.segmentId, values);
        }
      }
    }
    onProgress?.("逐段校订并提取方法");
    const cachedResult = await json<any>(
      path.join(dir, "analysis-result.json"),
    );
    const groundedSegments = segments.map((segment) => {
      const evidenceText = visualEvidence.get(segment.id);
      return evidenceText?.length ? { ...segment, evidenceText } : segment;
    });
    // Reattach supplements to checkpoints created before they were persisted.
    const recovered = await restoreAnalysis(groundedSegments);
    if (recovered) return recovered;
    const checkMethods = (result: any) => validateEvidence(
      result.methods,
      [{ id: raw.note.id, segments: groundedSegments }],
    );
    const result =
      cachedResult?.inputHash === inputHash
        ? cachedResult.result
        : await this.model.call<any>(
            dir,
            "analysis",
            `清洗一篇小红书笔记并提取作者的方法。cleanText必须返回空字符串；程序会按corrections生成保留全部段落的清洗稿。corrections.location填写准确segmentId，before必须是该段连续原文，after为修正，去掉无意义重复可用空字符串。只返回必要校正，不重写整篇正文。目的：保留原意、条件、否定、案例及推理。将“投姿/融姿”等明显避审替字校正为“投资/融资”并记录。视频口播有独立audio段落，不能只总结配文；逐段整理口播，保留可定位的[segmentId]。不得删去有信息量的段落。关键金额、数字、机构名仅在来源支持时校正；听写不明则列issues。critical仅表示原始内容无法可靠读取（关键漏页、听不清的关键数字），不能用于来源观点本身缺乏实证、评分规则重叠、宣传主张或适用条件不完整；这些属于方法的适用限制，记录为critical=false并在methods.exceptions明确保留。不要把个人意见普遍化，不编造经历。方法id以 ${raw.note.id}-m 开头，所有证据noteId必须为 ${raw.note.id}，segmentId必须存在，quote必须是原段落或该segment对应的图片校对补充中的简短连续子串；可空quote但不可无定位。区分explicit/inferred/external。外部知识这一步不补入。保留作者表达特点。若没有方法可提取可空数组，不为凑数发明框架。所有返回字段完整。\n标题:${raw.note.title}\n作者:${raw.note.author}\n<untrusted_source>\n${JSON.stringify(segments.map(({ imagePath, boxes, ...rest }) => rest))}\n</untrusted_source>\n图片校对补充（推导仍必须以原segment定位）：${visualNotes.join("\n")}`,
            analysisSchema,
            signal,
            [],
            checkMethods,
          );
    await atomic(path.join(dir, "analysis-result.json"), { inputHash, result });
    try {
      checkMethods(result);
    } catch (e) {
      await rm(path.join(dir, "analysis-result.json"), { force: true });
      throw e;
    }
    const cleanedParts: string[] = [];
    for (const segment of segments) {
      let text = segment.text,
        unmatched = false;
      for (const c of result.corrections.filter(
        (c: any) => c.location === segment.id,
      )) {
        const exact = c.before ? exactWhitespaceSpan(text, c.before) : null;
        if (exact === null) {
          unmatched = true;
          continue;
        }
        c.before = exact;
        text = text.replace(exact, c.after);
      }
      if (unmatched && segment.imagePath) {
        onProgress?.(`恢复表格与阅读顺序 · ${segment.id}`);
        const repairFile = path.join(dir, `layout-${segment.id}.json`);
        const repairHash = hash(
          segment.text + (await hashFile(segment.imagePath)),
        );
        let repair = await json<any>(repairFile);
        if (repair?.inputHash !== repairHash) {
          const output = await this.model.call<any>(
            dir,
            `layout-${segment.id}`,
            "忠实重建这张图片的全部正文与表格阅读顺序。OCR跨列混排导致局部替换失败，请以图片为准逐格读取；可以用Markdown表格。保留所有数字、比例、条件、否定、案例和页码，不摘要，不补充专业观点。只清理OCR错字、避审替字与阅读顺序。无法辨认的关键文字标[不清]并列issues；不能猜补。原图主张是否合理不影响转写，不要将案例数字改成通用标准。\n参考OCR：" +
              segment.text,
            {
              type: "object",
              properties: {
                text: { type: "string", minLength: 1 },
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      critical: { type: "boolean" },
                    },
                    required: ["message", "critical"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["text", "issues"],
              additionalProperties: false,
            },
            signal,
            [segment.imagePath],
          );
          repair = { ...output, inputHash: repairHash };
          await atomic(repairFile, repair);
        }
        text = repair.text;
        result.corrections = result.corrections.filter(
          (c: any) => c.location !== segment.id,
        );
        result.corrections.push({
          location: segment.id,
          before: segment.text,
          after: text,
          reason: "图像逐格复核，重建表格及阅读顺序",
        });
        result.issues.push(
          ...repair.issues.map((i: any) => ({ ...i, location: segment.id })),
        );
      } else if (unmatched)
        result.issues.push({
          location: segment.id,
          message: "校订原文无法匹配，已保留原文",
          critical: true,
        });
      cleanedParts.push(
        `### ${segment.id}${segment.start !== undefined ? " · " + segment.start.toFixed(2) + "s" : ""}${segment.page ? " · 第" + segment.page + "页" : ""}\n\n${text}`,
      );
    }
    const cleaned = cleanedParts.join("\n\n");
    const clean: CleanNote = {
      version: 1,
      id: raw.note.id,
      title: raw.note.title,
      segments: groundedSegments,
      cleanText: cleaned,
      corrections: result.corrections,
      issues: [...result.issues, ...timingIssues],
      inputHash,
      processorVersion: PROCESSOR_VERSION,
    };
    const value = { clean, methods: result.methods, style: result.style };
    await atomic(path.join(dir, "analysis.json"), value);
    await atomic(
      path.join(dir, "clean.md"),
      `# ${raw.note.title}\n\n${clean.cleanText}`,
    );
    return value;
  }
}
