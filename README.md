# Cluefolio

**把值得反复看的笔记，变成随时能提问、能回到原文的知识库。**

你可能收藏了很多博主的笔记。等到真正遇到问题时，却忘了哪篇讲过，也记不清这是博主自己的经验，还是转述的一篇文章。

Cluefolio 帮你把选中的小红书笔记整理到本机。它会读取正文、图片和视频，寻找相关的上游来源，保留博主自己的解释。之后你可以提问，让 Codex 结合材料回答，并找到原笔记、图片页或视频时间点。

## 怎么用

1. 在 Codex Desktop 里打开笔记选择器，或打开本地网页工作台。
2. 导入博主主页或几条笔记链接，选出想保留的内容。默认最多选 10 篇，可在项目设置中调整。
3. 开始整理。Codex 使用你自己的登录和模型；中途遇到登录、验证或其他阻碍时，可以恢复原任务。
4. 整理完成后，在工作台首页输入问题，查看相关片段和出处；也可以让 Codex 根据这些材料回答。

比如，你选了几篇讨论天使轮融资的笔记。之后问“投资人通常怎么看早期项目”，Cluefolio 会尝试找到相关片段，帮助你回看博主的解释和可用的上游资料。答案质量仍取决于你选择的材料和模型，请核对重要结论。

## 适合谁

首版面向使用 **Apple Silicon Mac 和 Codex Desktop**、希望整理小红书精选笔记的人。你需要自己的 Codex 登录、模型使用额度和可访问的小红书浏览器会话。其他 Agent 的配置属于实验功能。

项目目前是 **v0.1.0-rc4 预发布候选**。图片文字和视频转写可能有误；查源也可能遗漏。现有评测已由独立 LLM 逐项复核，但不是融资专家或人工标注，不能代表所有博主或领域的效果。详见[验收说明](docs/validation.md)和[发布边界](docs/release-readiness.md)。

你的材料和生成的知识库默认保存在本机。模型分析所需的内容会发送给你当前使用的模型服务；请在导入前自行判断材料是否适合这样处理。

## 开始使用

```sh
git clone https://github.com/Mingbash/Cluefolio.git
cd Cluefolio
```

要求 Apple Silicon Mac、Node.js 24、已登录的 Codex CLI，以及连接 Chrome 的 OpenCLI。媒体安装步骤需要已安装 Homebrew；OCR 编译需要 Xcode Command Line Tools（缺少时运行 `xcode-select --install`）。本机正式验收使用 OpenCLI 1.8.8。

```sh
npm ci
npm install -g @jackwener/opencli@1.8.8  # 仅在尚未安装时运行
brew install ffmpeg whisper-cpp
npm run setup
npm run build
codex mcp add shizhi-desktop -- "$(command -v node)" "$PWD/scripts/desktop-mcp.mjs"
npm start
```

`shizhi-desktop` 是早期版本留下的连接名称。保留它能让已有本地任务继续工作；界面与项目名称均为 Cluefolio。

打开 [本地工作台](http://127.0.0.1:4317/)，新建项目并导入笔记。默认最多选择 10 篇，可在项目设置中调整。已有知识库时，首页直接按问题找原文；笔记库、任务、结果和设置分别记住当前项目。

在 macOS 上也可以双击项目根目录的 `启动Cluefolio.command`。它会使用系统自带的 `screen` 创建分离会话并自动打开网页，因此关闭启动用的 Terminal 窗口或结束 Codex 任务不会停止服务。停止由启动器开启的服务可运行 `./启动Cluefolio.command --stop`。

Whisper 模型默认放在 `data/models/ggml-large-v3-turbo.bin`。官方模型地址：https://huggingface.co/ggerganov/whisper.cpp 。该版本的 SHA-256 为`1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`。

## 配置

环境变量：`XHS_DATA_DIR`、`PORT`（默认4317）、`CODEX_BIN`、`OPENCLI_BIN`、`FFMPEG_BIN`、`WHISPER_BIN`、`WHISPER_MODEL`、`VISION_BIN`、`CODEX_MODEL`（可选覆盖模型）、`XHS_PROCESSING_CONCURRENCY`（默认 2，上限 4）。

可选数据服务：同时设置 `GUAIKEI_ENABLED=true` 和 `GUAIKEI_API_TOKEN` 才启用；按该服务计费，不自动购买额度。接口适配沿用 creator-buddy 的 Guaikei 路由，未配置真实密钥时仅完成契约测试，不能声称已实测。

默认只监听本机，校验 Host、Origin 与 JSON 请求类型。原始分享链接在本地数据目录中保留，日志脱敏；导出不携带访问令牌。媒体只接受小红书 CDN 并校验重定向。同一任务的续跑共用一个 1,000,000 token 的输入账本，超过预算时停止发送新材料，并保留检查点。桌面版按 Cluefolio 发送的文本、工具参数和图片保守估算，宿主的系统提示、聊天历史和外部搜索结果由宿主计量。命令行额外预留运行预算，并在 Codex 报告输入用量后核账。

## SDK

```ts
import { Distiller, config } from "@local/xhs-distiller";
const sdk = new Distiller(config(process.cwd()));
const project = sdk.createProject("我的精选", "creator-advisor");
await sdk.importNoteLinks(project.id, ["完整笔记分享链接"]);
await sdk.hydrate(project.id);
// 用户选择后，持久化选择并启动后台任务。
sdk.updateProject(project.id, { selected: ["笔记ID"] });
const job = sdk.startDistillation(project.id);
await sdk.waitJob(job.id);
console.log(sdk.getJob(job.id));
await sdk.close();
```

SDK 还提供 `inspectEnvironment`、`listAuthorNotes`、`fetchNote`、`cleanNote`、任务恢复，以及 Context 的迁移、查源、综合、校验、索引、注册和导出能力。SDK 使用当前 Codex 登录并继承用户配置的模型名；内容分析阶段禁用外部工具，查源阶段只允许联网搜索和网页读取。SDK 提供编译后的 ESM 与类型声明，可通过 dist/local-xhs-distiller-0.1.0.tgz 安装到其他项目。

CLI 除采集与任务命令外，还提供 `context:migrate`、`context:build`、`context:verify`、`context:index`、`context:register` 和 `context:search`。MCP Runtime 使用 `npm run context:mcp` 启动。

查源因网络或进程中断时，可以继续处理未完成的观点。续跑保留已用预算，预算用尽后会停止投递新材料。

## 数据与产物

- `data/state.sqlite`：项目、选择、扫描状态、任务状态。
- `data/projects/<项目>/notes/<笔记>`：原始响应、校验过的媒体、OCR、字幕、清洗稿与逐篇方法。
- `data/projects/<项目>/jobs/<任务>`：清洗材料、兼容 Skill、来源包、质量报告与行为测试。
- `data/contexts/<contextId>/<version>`：正式 Context Package，包括 manifest、来源、Evidence Units、Claims、归因边、创作者贡献、Thesis、Axioms 和本地索引。
- `data/context-exports`：供本人本机使用的完整 Context ZIP；未来 portable-safe 导出会沿用 manifest 中的版权范围与脱敏字段。

技能 ZIP 不包含完整原始媒体。原始媒体保留在本机用于核对。来源包包含逐字稿、清洗口播稿、图片文字、校订记录、方法映射和质量报告。生成结果分为完成、暂停/草稿；未处理内容不会被静默丢弃。行为测试是模型独立运行与评审，不等同于作者本人确认。

当前数据提供者的结束判断必须有页面结束标记；无增长只算暂停。主页扫描可以重新遍历并合并到原列表，成功获取的详情和媒体复用缓存。日期与互动指标属于获取时的快照。

## 测试

```sh
npm test
npm run build
```

核心测试在临时目录使用模拟提供者，不依赖已有项目或登录。参见[验收说明](docs/validation.md)。采集因验证码暂停时，在 Chrome 完成验证后恢复。模型文件需单独下载。首次使用 OpenCLI 时，请连接 Chrome 扩展。

账号列表先增量展示，遍历结束或停滞后开始补齐详情。暂停可保留已有列表；继续会重新遍历并按 ID 合并。仅加载标题/封面及详情元数据，完整媒体只在所选材料蒸馏时下载。封面会缓存到本地，已下载媒体也可作为本地封面来源。

生成包安装入口只对通过检查的结果开放；草稿可以下载查看。要将 SDK 集成到其他程序，可传入自己的 `Provider` 实现，网页和 CLI 共用 SDK 的状态与处理流程。

## Codex Desktop：在对话里构建 Context

在仓库根目录安装依赖后，把本机服务注册到 Codex。下面的命令从当前目录定位代码，适用于 Clone 或 Fork 后的仓库。真实采集还需完成上面的本地媒体依赖和 OpenCLI 配置。

```sh
npm ci
codex mcp add shizhi-desktop -- "$(command -v node)" "$PWD/scripts/desktop-mcp.mjs"
```

如果桌面进程找不到 OpenCLI，可在注册时加 `--env "OPENCLI_BIN=$(command -v opencli)"`。在 Codex Desktop 新开一个本地任务，发送：

> 用 Cluefolio 打开笔记选择器。我授权在点击「开始蒸馏」后，执行我在卡片中选择的笔记，直到完成或遇到需要我处理的阻塞。

也可以附上博主主页、笔记分享链接，或指定本机已有项目。卡片支持按项目筛选、搜索和分页，勾选跨页保留。点击开始后，当前 Codex 任务接续清洗、查源和综合，沿用用户自己的模型与额度。选择器发送的任务编号只用于关联用户已授权的任务。

中断后可在卡片点「继续蒸馏」，也可在新的本地 Codex 任务发送「用 Cluefolio 继续任务 <任务编号>」。完成的模型步骤和本地媒体检查点会复用。如果原会话仍在运行，请先暂停原任务，再在新的会话继续。Cluefolio 按任务累计已投递的材料和图片。

本地网页是备用入口。网页勾选并创建任务后，在任务页复制续跑指令到 Codex。网页和对话卡片查看同一份进度。新版桌面流程产出可检索的 Context Package，兼容 Skill 不是新任务的必需产物。插件连接使用本机 stdio，网页只监听本机回环地址。要撤销注册，运行 `codex mcp remove shizhi-desktop`。

### 其他 Agent 的实验性配置

对于能从本地启动 MCP 进程的 Agent，在其 MCP 设置里将以下配置合并到 `mcpServers`。将占位路径替换为本机路径。适配器沿用宿主模型，界面渲染及自动续接取决于宿主支持情况。首版仅验收 Codex Desktop；其他宿主若只能调用工具，可用本地网页创建任务后手动提交编号。

```json
{
  "mcpServers": {
    "shizhi-desktop": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/xhs-skill-distiller/scripts/desktop-mcp.mjs"],
      "env": {
        "OPENCLI_BIN": "/absolute/path/to/opencli"
      }
    }
  }
}
```

需要自定义存放位置时，让网页和 MCP 进程使用同一个 `XHS_DATA_DIR`。保留真实笔记、浏览器会话和 Context 在自己的数据目录；模型阶段读取的必要资料会由宿主发给用户当前使用的模型服务。


## 许可与数据

源码采用 [MIT 许可证](LICENSE)。你导入的笔记、媒体、逐字稿和生成的本地 Context 由你在本机管理，源码许可不覆盖这些内容。完整 Context ZIP 用于本地备份，其中可能包含原文或转写。

## 参与和发布

欢迎通过 Issue 和 PR 改进。开发与测试步骤见 [贡献指南](CONTRIBUTING.md)。维护者运行 `npm run release:candidate` 生成已筛选的源码 ZIP 和校验清单。首次公开请使用该干净快照建立新仓库，不要推送含私有工作记录的开发历史。
