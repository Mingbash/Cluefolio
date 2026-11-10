# Cluefolio v0.2.0-rc1

Cluefolio 现在以“Context 淘金盆”为产品入口：从你选的笔记里找能长期使用的判断原则，并把条件、来源日期、上游原作与博主自己的解释留在 Context 中。

## 这次新增

- 每个新 Context 默认生成并安装轻量调用 Skill。Agent 聊天里选择该 Skill，即可按问题读取 Context；草稿也会明确标记。
- 证据和观点带来源日期与时效提示。价格、平台规则、市场数字和具体建议需要先核对当前一手来源；缺日期显示“日期未确认”。
- 每个项目可配置新任务的材料预算，默认 1,000,000 token。任务预算跨续跑累计；不足时显示进度、剩余笔记和预计追加量，可生成草稿或提高预算后继续。
- 桌面连接、卡片事件、资源地址、浏览器存储键和公开源码统一使用 Cluefolio 名称。升级脚本按项目路径迁移旧连接，保留数据与任务。
- README 首次安装入口改为给 Agent 的依赖检查指令，解释了 Guaikei 付费备选的作用和边界。
- 公开 CI 分别检查 Apple Silicon 与 Intel Mac 的安装、测试、构建及 macOS Vision OCR；ChatGPT Desktop 的 Codex 本地任务仍是正式验收宿主。

## 使用边界

OCR、语音转写和自动查源仍需核对。时效提示是回答规则，不保证 Agent 已经成功访问最新来源。1,000,000 token 是 Cluefolio 投递材料的预算，并非整段 Agent 会话账单。其他 Agent 的配置仍是实验性路径。

源码使用 MIT License。源码包不包含用户的笔记、媒体和 Context 数据。请从 README 的 Agent 安装指令开始。
