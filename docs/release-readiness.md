# v0.2.0-rc1 发布检查

## 已完成的本机检查

- 工作台、SDK 与 Desktop MCP 使用同一份任务和 Context 数据；旧连接按本机项目路径迁移，未移动 `data/`。
- 41 项自动测试通过，包括桌面长任务跨进程恢复、默认调用 Skill 安装、预算持久化与增额、时间敏感度、来源冲突及来源日期。
- TypeScript 类型检查、网页构建、OpenCLI 插件语法检查通过。
- Apple Silicon 本机 Vision OCR 编译和基础运行通过。Intel Mac 使用 GitHub CI 的 `macos-15-intel` 验收；它不能被本机 Arm 测试代替。
- README、贡献指南、发布说明、Loom 脚本进入干净源码候选；私有数据和访问凭据由发布脚本排除并扫描。
- 独立视觉复核检查了桌面与手机宽度：首页提问入口、分栏项目切换、设置中的预算、结果中的日期与 Skill 预览均通过；无横向溢出。
- 最终源码 ZIP 在独立目录完成离线 `npm ci`、41 项测试、构建、OpenCLI 插件语法检查；空工作台在 `127.0.0.1:4318` 启动并返回 0 个项目。
- GitHub CI 的 Apple Silicon (`macos-latest`) 与 Intel (`macos-15-intel`) 两条任务均通过依赖安装、测试、构建、Vision OCR、媒体工具与源码打包。
- 本机 Codex CLI 用已安装的 `dujiangang_invest` Skill，通过新 `cluefolio-desktop` MCP 成功调用 `get_overview` 和 `build_context_packet`。旧项目与 Context 文件保留。

## 预发布仍需真实使用反馈

- ChatGPT Desktop 重载新连接后，在对话内实际勾选并构建一份新 Context，再在任务聊天中选中自动安装的 Skill 回答。自动集成测试和 Codex CLI 已验证相同 MCP 与 Skill 路径，但本次更新后还没有重复这一步桌面窗口操作。
- 新预算暂停在真实长任务中的估算值仍需更多语料校准；用户可按剩余笔记增额或生成草稿。

这是预发布版本；上述真实桌面流程的反馈会进入下一轮修订。源码许可不覆盖用户导入的笔记和媒体；完整 Context ZIP 只用于本地备份。已有 LLM 复核是独立模型评审，不等于融资专家或作者本人确认。
