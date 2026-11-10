# Cluefolio

**Context 淘金盆：把收藏过的笔记，变成工作时能用的判断依据。**

你刷到一位博主讲 LinkedIn 运营，收藏了几篇。一个月后真要做账号，想不起哪篇谈过选题，也不知道那条“最新玩法”现在还管不管用。Cluefolio 让你挑出值得研究的笔记，读取文字、图文和视频，找到可核对的上游来源，留下博主自己的解释，再提炼能反复使用的原则与适用条件。

完成后得到一份 **Context Package**，以及默认安装的轻量调用 Skill。在 Agent 的任务聊天里选择这个 Skill 提问；回答可以指向原始文章、笔记、图片页或视频时间点。涉及价格、平台规则、市场数字和操作建议时，Agent 应先核对当前一手来源。没有来源日期的材料会标成“日期未确认”。

| 做法 | 适合什么 | 在这个场景里还需要什么 |
| --- | --- | --- |
| 让模型临时搜索 | 快速了解当前公开信息 | 每次重新找资料；博主长期形成的判断与贡献需要重新辨认 |
| 普通检索库 | 找回原文片段 | 仍需判断上游事实、博主解释和观点的适用条件 |
| 从笔记直接写成长 Skill | 固定一套简短工作步骤 | 长材料压缩后，日期、例外和精确出处容易丢失 |
| Cluefolio | 为精选材料建立可追溯的 Context | 原始材料与提炼结果分开保存；把更稳定的原则放在前面，并提示时效核查 |

这些方法可以搭配使用。Cluefolio 的重点是让去年的具体做法不会悄悄成为今年的建议。

## 开始使用：把这段发给你的 Agent

先把 [仓库链接](https://github.com/Mingbash/Cluefolio) 发给 Agent，再复制下面这段。它会先检查环境，不会直接安装或下载：

> 请帮我在本机安装 Cluefolio（https://github.com/Mingbash/Cluefolio）。先只读检查：操作系统和架构、Node.js 24、Git、用于本机 MCP 的 ChatGPT Desktop Codex 本地任务、模型登录、Chrome 与 OpenCLI Browser Bridge、macOS OCR 编译所需工具、FFmpeg、whisper.cpp 及其 large-v3-turbo 模型文件。一次列出全部缺项、每项的用途、可替代路径，以及哪些步骤要下载文件、改变本机配置或可能产生费用。先给我安装方案并请求必要授权；得到授权后再安装。安装结束请验证桌面笔记卡片、本地工作台、模拟材料的构建与调用 Skill。保留我已有的 Cluefolio 项目和任务数据。

默认使用本机浏览器读取小红书。你需要自己可访问的浏览器会话和模型登录。**Guaikei 不必购买或配置**，见下方说明。安装完成后，在 ChatGPT Desktop 的 Codex 本地任务中让 Cluefolio 打开笔记选择卡片；勾选笔记，点击“开始构建”。任务完成后，在 Agent 聊天中选择自动安装的 Context Skill 提问。本地网页工作台 `http://127.0.0.1:4317/` 是备用入口，也可以在其中查看进度和来源。

## 适合谁

适合已经收藏了某位博主的多篇干货、想在具体工作里反复使用的人。默认验收路径是 **Mac 上 ChatGPT Desktop 的 Codex 本地任务**。项目不按 Apple 芯片型号排除用户；Intel Mac 的构建与基础处理由双架构 CI 检查。普通 ChatGPT 对话、Windows 和其他 Agent 尚未完成同等验收，文末提供实验性配置。

当前是预发布版本。OCR、视频转写和自动查源可能产生疑点；系统会保留原始材料、定位和处理状态，供核对。模型阶段使用你自己的 Agent 与模型额度。导入的材料和 Context 默认保存在本机；Agent 处理所需内容会发送给你使用的模型服务。

## 你会得到什么

- **Context Package**：Core Thesis、Public Axioms、适用条件、观点与证据关系、上游来源、博主贡献，以及文字、图片页和视频时间码。
- **调用 Skill**：每个 Context 默认生成并安装。它只保存 Context 标识和回答规则，不复制整份材料；草稿会在名称和回答中标明。
- **本地原始材料**：分享链接、响应、下载的媒体、转写、OCR、清洗稿和质量记录，用于回查。完整媒体不会进入可分发 Skill。

默认每次最多勾选 10 篇，项目设置可调整。每项任务默认有 **1,000,000 token 材料预算**，可配置且跨续跑累计。预算不足时暂停投递新材料，显示已完成和剩余笔记及预计追加量。你可以用已完成部分生成草稿，或提高该任务预算继续。这个数字是 Cluefolio 投递材料的保守估算，不是 Agent 整段会话的精确账单。

## 手动安装与运行

以下命令是 ChatGPT Desktop 的 Codex 本地任务专用路径。先检查依赖、取得必要安装授权，再运行对应命令。

```sh
git clone https://github.com/Mingbash/Cluefolio.git
cd Cluefolio
npm ci
npm run setup
npm run build
npm start
```

Node.js 需 24 或更新。`npm run setup` 编译 macOS Vision OCR、安装项目的 OpenCLI 采集插件，并注册本机 MCP。需要单独重建本机连接时，可运行 `npm run mcp:migrate`；首次手动注册也可使用 `codex mcp add cluefolio-desktop -- "$(command -v node)" "$PWD/scripts/desktop-mcp.mjs"`。视频处理需要 FFmpeg、whisper.cpp 和模型文件；模型默认路径为 `data/models/ggml-large-v3-turbo.bin`，可用 `WHISPER_MODEL` 指定别处。[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 提供工具与模型说明。OpenCLI Browser Bridge 需要在 Chrome 中连接。缺少依赖时，先按安装指令一次性检查后处理。

如果你从旧版升级，安装脚本会按本机 MCP 注册指向的项目路径替换旧连接名称，并更新已安装的调用 Skill；项目、Context 和任务数据仍留在原来的 `data/` 或 `XHS_DATA_DIR`。不要用新的空数据目录覆盖旧目录。

Mac 上可双击 `启动Cluefolio.command` 打开备用工作台；关闭启动用的终端窗口不会停止它。用 `./启动Cluefolio.command --stop` 停止。服务只监听本机回环地址。

### Guaikei 要不要启用？

**默认关闭。** 不启用时，Cluefolio 使用本机 Chrome 的 OpenCLI 连接读取公开可访问笔记；浏览器连接或页面解析故障会暂停，等待你修复后继续。启用时，同时设置 `GUAIKEI_ENABLED=true` 与 `GUAIKEI_API_TOKEN`，仅在这两类故障时尝试付费接口。它可能增加恢复机会，但相关笔记链接和请求会经过该服务，并按服务规则产生费用。小红书登录失效、安全验证仍需你在浏览器处理；Guaikei 不会绕过。Cluefolio 不自动购买额度。

### 配置

常用环境变量：`XHS_DATA_DIR`、`PORT`（默认 4317）、`OPENCLI_BIN`、`FFMPEG_BIN`、`WHISPER_BIN`、`WHISPER_MODEL`、`VISION_BIN`、`XHS_PROCESSING_CONCURRENCY`（默认 2）、`GUAIKEI_ENABLED` 与 `GUAIKEI_API_TOKEN`。项目设置中的材料预算默认 1,000,000 token，可调整新任务的上限；预算耗尽后可对当前任务单独增加。

## 在 Agent 聊天中使用

首次构建时，在 ChatGPT Desktop 的 Codex 本地任务发送：

> 用 Cluefolio 打开笔记选择器。我授权在点击“开始构建”后，执行我选中的笔记，直到完成或遇到需要我处理的阻塞。

卡片可切换项目、搜索、跨页勾选。点击“开始构建”后，当前 Agent 接续读取、查源、综合和保存；登录验证或模型额度问题会暂停并保留检查点。中断后点“继续构建”，或在新的本地任务里说“用 Cluefolio 继续任务〈任务编号〉”。同一任务的材料预算和已完成步骤不会归零。

Context 完成后，在新的 Agent 任务聊天中选中它自动安装的 Skill，例如 `dujiangang_invest`，再提出任务。Skill 会调用本机 `cluefolio-desktop` MCP 读取证据。工作台首页可先找相关原文，但完整咨询任务建议从 Agent 聊天进入。

### 其他 Agent 的实验性配置

能启动本地 MCP 进程的 Agent 可尝试下面的配置，把绝对路径换成自己的环境。卡片显示、点击后自动接续和 Skill 选择取决于宿主能力，当前不承诺同等验收。

```json
{
  "mcpServers": {
    "cluefolio-desktop": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Cluefolio/scripts/desktop-mcp.mjs"]
    }
  }
}
```

## 开发与验证

```sh
npm ci
npm test
npm run build
npm run release:candidate
```

SDK 暴露 `inspectEnvironment`、`listAuthorNotes`、`importNoteLinks`、`fetchNote`、`cleanNote`、任务创建/恢复、Context 查源/索引/检索/导出接口。网页与 MCP 共用持久化状态。`data/state.sqlite` 保存项目、选择和任务；`data/projects/` 保存原始材料与逐篇检查点；`data/contexts/` 保存 Context Package。发布包由筛选后的源码生成，不包含本机数据与历史记录。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，验收边界见 [docs/validation.md](docs/validation.md)。

源码使用 [MIT License](LICENSE)；源码许可不覆盖用户导入的笔记、媒体与转写。完整 Context ZIP 可能包含原文，仅供本地备份。项目的思路受[立正老师的 Open Context](https://github.com/sunyuzheng/lizheng-open-context)启发。
