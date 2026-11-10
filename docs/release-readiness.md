# v0.2.0-rc1 发布检查

## 已完成的本机检查

- 工作台、SDK 与 Desktop MCP 使用同一份任务和 Context 数据；旧连接按本机项目路径迁移，未移动 `data/`。
- 41 项自动测试通过，包括桌面长任务跨进程恢复、默认调用 Skill 安装、预算持久化与增额、时间敏感度、来源冲突及来源日期。
- TypeScript 类型检查、网页构建、OpenCLI 插件语法检查通过。
- Apple Silicon 本机 Vision OCR 编译和基础运行通过。Intel Mac 使用 GitHub CI 的 `macos-15-intel` 验收；它不能被本机 Arm 测试代替。
- README、贡献指南、发布说明、Loom 脚本进入干净源码候选；私有数据和访问凭据由发布脚本排除并扫描。
- 独立视觉复核检查了桌面与手机宽度：首页提问入口、分栏项目切换、设置中的预算、结果中的日期与 Skill 预览均通过；无横向溢出。

## 发布前仍需看到的结果

- 从最终候选 ZIP 解压到独立目录完成 `npm ci`、41 项测试、构建与工作台启动。
- GitHub 两种 Mac 架构 CI 均通过，包括 Vision OCR 与媒体工具检查。
- 桌面卡片到新 Context 的构建，以及在 Agent 聊天中选择自动安装 Skill 并回答，做一次真实宿主验收。
- ChatGPT Desktop 在重载新连接后确认调用 Skill 可选；本机 MCP 直连已读回旧 `dujiangang_invest` Context。

候选包通过后发布预发布版本。源码许可不覆盖用户导入的笔记和媒体；完整 Context ZIP 只用于本地备份。已有 LLM 复核是独立模型评审，不等于融资专家或作者本人确认。
