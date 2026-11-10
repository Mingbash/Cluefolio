// Keep stored task names and error codes stable while translating them for the workbench.
export const jobStages: Record<string, string> = {
  获取原始内容: "下载笔记",
  提取与清洗: "整理正文、图片和视频",
  "提取 Claim": "提取笔记要点",
  "生成兼容 Skill": "准备 Codex 技能",
  验证兼容入口: "测试 Codex 技能",
  自动查源与原创性判断: "查找和核对来源",
  "综合 Thesis 与 Public Axioms": "整理观点和判断原则",
  索引与打包: "准备搜索和下载",
  "Context 草稿待完善": "草稿已保存",
  已完成: "已完成",
};

export const stageTimingLabels: Record<string, string> = {
  acquire: "下载笔记",
  clean: "整理笔记",
  unitize: "提取要点",
  discover: "查找来源",
  verify: "核对来源",
  attribute: "判断观点出处",
  synthesize: "整理观点和原则",
  index: "准备搜索",
  evaluate: "检查结果",
  package: "打包文件",
  register: "保存 Context",
};

const errors: Record<string, string> = {
  INVALID_URL: "请复制并粘贴小红书的完整分享链接。",
  BROWSER_CONNECT:
    "Cluefolio 连不上 Chrome。请检查 OpenCLI 浏览器扩展的连接，再试一次。",
  SECURITY_BLOCK: "小红书要求安全验证。请在 Chrome 里完成验证，再继续。",
  AUTH_REQUIRED: "需要重新登录。请在 Chrome 检查小红书登录状态，再继续。",
  BUSY: "这项操作还在进行。请等它结束后再试。",
  EXECUTOR: "请复制任务指令，到 Codex Desktop 开始或继续。",
  TOKEN_BUDGET: "这个任务已用完 AI 处理额度。已完成的部分仍可查看。",
  QUOTA: "Codex 暂时达到使用上限。额度恢复后可以继续。",
  NOT_FOUND: "找不到这项内容。请刷新页面，确认它还在。",
  NOT_READY: "文件还在准备中。请到任务进度查看当前状态。",
  CONTENT_MISSING:
    "这篇笔记的正文或媒体没有读全。请打开原笔记确认它还能访问，再试一次。",
  CHECKPOINT: "本机缺少所需的笔记文件。请联网后再继续。",
  MODEL_OUTPUT: "Codex 返回的结果没通过检查。可以继续任务，再试一次。",
  TIMEOUT: "等候时间过长。请检查网络或浏览器连接，再试一次。",
  EXISTS: "Agent 已装有同名 Skill。请在项目设置换个 Context 标识，再重新创建任务。",
};

export function friendlyFailure(
  detail?: string,
  code?: string,
  fallback = "操作没完成。请重试。",
) {
  if (code && errors[code]) return errors[code];
  if (!detail) return fallback;
  if (/验证码|安全验证|安全限制|captcha/i.test(detail))
    return errors.SECURITY_BLOCK;
  if (
    /opencli|browser bridge|浏览器.{0,5}(连接|桥接)|extension.*connect/i.test(
      detail,
    )
  )
    return errors.BROWSER_CONNECT;
  if (/1,000,000|累计模型输入|输入安全预算/.test(detail))
    return errors.TOKEN_BUDGET;
  if (/额度|usage.limit|rate.limit/i.test(detail)) return errors.QUOTA;
  if (/codex.{0,35}(登录|log.?in)|(登录|log.?in).{0,35}codex/i.test(detail))
    return "请先登录 Codex，再继续这个任务。";
  if (/登录|log.?in/i.test(detail)) return errors.AUTH_REQUIRED;
  if (/超时|timeout/i.test(detail)) return errors.TIMEOUT;
  if (/上次运行中断|加载中断/.test(detail))
    return "上次运行中断了。已保存的进度可以继续使用。";
  if (/已加载|连续.{0,10}没有新增|停滞|无增长|没有继续增长/.test(detail))
    return "暂时没有读到更多笔记。可以继续加载，已找到的笔记会保留。";
  if (/本地.*(缺失|校验)|检查点/.test(detail)) return errors.CHECKPOINT;
  return fallback;
}

export function noteProgress(detail: string) {
  if (/表格/.test(detail)) return "正在核对表格和阅读顺序";
  if (/画面|图片|图像/.test(detail)) return "正在核对图片和视频画面";
  if (/逐段|校订/.test(detail)) return "正在核对文字并整理要点";
  return "正在读取正文、图片文字和视频口播";
}

export function setupStatus(name: string, ready: boolean) {
  if (ready)
    return name === "codex"
      ? "已登录"
      : name === "browser"
        ? "已连接"
        : "可以使用";
  return (
    (
      {
        browser: "请打开 Chrome 并连接 OpenCLI 扩展。",
        codex: "请先登录 Codex。",
        ffmpeg: "请安装 FFmpeg 后再处理视频。",
        whisper: "请安装语音转写工具 whisper.cpp。",
        model: "请下载语音识别文件，放到安装说明指定的位置。",
        ocr: "请按安装说明设置图片文字识别。",
        guaikei: "未启用。使用浏览器读取笔记时可以跳过。",
      } as Record<string, string>
    )[name] ?? "暂不可用。请查看安装说明。"
  );
}
