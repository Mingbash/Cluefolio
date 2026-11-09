import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, stat } from "node:fs/promises";
import { config, run } from "../packages/sdk/src/index.ts";
const cfg = config();
await mkdir(path.dirname(cfg.visionBin), { recursive: true });
await run(
  "swiftc",
  [
    path.resolve("scripts/vision.swift"),
    "-o",
    cfg.visionBin,
    "-module-cache-path",
    path.join(cfg.dataDir, "swift-cache"),
  ],
  { timeout: 180000 },
);
const pluginDir = path.resolve("packages/opencli-plugin");
const pluginUrl = pathToFileURL(pluginDir);
await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: pluginDir,
  timeout: 120000,
});
await run(
  cfg.opencliBin,
  ["plugin", "install", pluginUrl.href],
  { timeout: 120000 },
);
console.log("OCR 和 OpenCLI 插件已安装。");
for (const bin of [cfg.ffmpegBin, cfg.whisperBin])
  try {
    await run(bin, ["-h"], { timeout: 10000 });
    console.log(bin + " 已就绪");
  } catch {
    console.log("缺少 " + bin + "；运行 brew install ffmpeg whisper-cpp");
  }
try {
  const size = (await stat(cfg.whisperModel)).size;
  if (size < 1e9) throw new Error();
  console.log("语音模型已配置");
} catch {
  console.log(
    "请把 large-v3-turbo GGML 模型放到 " +
      cfg.whisperModel +
      "，或设置 WHISPER_MODEL。来源：https://huggingface.co/ggerganov/whisper.cpp",
  );
}
