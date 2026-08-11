# Claude Workbench

Claude Workbench 是一个面向 Claude Code 的 Electron 桌面客户端。真实 Agent 任务始终由本机 Claude Code CLI 执行，应用继承现有登录状态、环境变量、`CLAUDE.md`、`.claude/settings.json`、MCP 和 Skills。模型中心会向供应商发送最小连接测试或模型发现请求，并通过 Electron `safeStorage` 加密保存应用 Provider 凭证；已保存凭证不会回传到 Renderer、日志或诊断包。

## 核心能力

- 按项目和会话隔离的任务列表、草稿、历史消息、实时消息、工具记录和运行状态
- Claude Code 本地历史读取，以及明确会话 ID 的精确续聊
- 流式文本聚合、工具调用状态、Token 用量和耗时
- 标准、接受编辑、规划、跳过权限四种 UI 权限模式的严格 CLI 映射
- 真实权限回传：Claude Code → 会话专用 MCP 权限工具 → 主进程 PermissionBroker → Electron 弹窗 → Claude Code
- 权限允许一次、本次运行始终允许、拒绝、超时拒绝和停止清理
- 会话重命名、归档、取消归档、完整分叉和有稳定消息 ID 时的消息级分叉
- 中文界面、浅色/深色主题、文件改动面板和集成终端
- Agent Task 页面：任务状态、模型、耗时、Token、文件/行数、测试和权限统计
- 人类可读 Agent Timeline，以及不调用模型的确定性结果卡、复制和 Markdown 导出
- Monaco 懒加载 Diff：单文件/全部修改、Split/Unified、多语言和 5000 行/2 MiB 保护
- Git 工作区抽屉：分支、staged/unstaged/untracked、行数统计、按文件打开 Monaco Diff
- AI Checkpoint：任务前、编辑后、测试后和完成后自动快照，支持手动快照与历史恢复
- 安全接受/恢复/提交：任务修改归属、用户原有修改保护、恢复影响预览、确定性 Commit Preview 与显式确认
- 可跨项目并行的后台 TaskManager；同一项目的写任务互斥，规划/审查保持只读
- 普通、规划、开发、审查四种应用层 Agent 策略，不绕过 Claude Code 权限
- 项目任务分组、虚拟滚动、项目设置、收藏/归档与“只删除索引”安全菜单
- MCP/Skills 只读发现中心；MCP 启停只存项目级 Workbench 覆盖，不改用户全局配置
- VS Code 风格命令面板和 `Ctrl+N / Ctrl+P / Ctrl+K / Ctrl+Shift+P / Ctrl+Enter / Ctrl+Shift+Enter`

## 环境要求

- Node.js 22 或更新版本（`better-sqlite3` 13 的运行要求）
- Claude Code CLI（建议使用当前已验证的 2.1.218 或更新版本）
- Git（文件改动功能需要）

```powershell
npm install
npm run dev:electron
```

生产构建与启动：

```powershell
npm run build
npm start
```

验证：

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

## 运行模型

每次发送提示词只创建一个 Claude 子进程。新任务使用参数数组，不经过 shell 拼接：

```text
claude -p <prompt> --output-format stream-json --verbose --permission-mode <mode>
```

明确续聊时额外传入：

```text
--resume <claude-session-id>
```

单次 `-p` 模式的 stdin 设为 `ignore`，不会再同时传入 `--input-format stream-json`，因此不会等待一条永远不会写入的 stdin 消息。日志中的提示词与 MCP 配置会被脱敏。

权限映射固定为：

| UI | Claude Code CLI |
| --- | --- |
| `standard` | `default` |
| `accept-edits` | `acceptEdits` |
| `plan` | `plan` |
| `bypass` | `bypassPermissions` + 危险确认 |

非 bypass 运行会附加会话专用 MCP 配置和 `--permission-prompt-tool mcp__workbench_permissions__request_permission`。PermissionBroker 只监听 `127.0.0.1` 随机端口，每个 run 使用独立随机 bearer token；决定只在内存中存在，五分钟未处理即拒绝。高风险命令不会进入“本次运行始终允许”的缓存。

## 状态与身份

项目以规范化 `projectPath` 标识，会话以 `projectPath::sessionId` 标识。项目列表请求、会话历史请求和 CLI 事件分别使用 requestId、sessionKey 与 runId 校验，迟到结果不能写入当前选择。各会话独立保存：

- 消息与草稿
- 工具调用与诊断
- Token 用量
- 当前 runId
- `idle / loading_history / running / waiting_permission / completed / failed / cancelled` 状态

点击历史只读取消息，不启动 Claude；用户真正发送下一条消息时才用该历史的真实 Claude session ID 续聊。

## 目录结构

```text
src/
  main/
    claude/             Claude CLI、stream-json 解析与本地历史适配器
    permissions/        loopback PermissionBroker 与独立 MCP helper
    ipc/                参数校验和主进程 IPC
    database/           better-sqlite3、自动迁移与分页查询
    tasks/              后台并发锁、事件记录、任务查询和固定报告
    file-changes/       无 shell 拼接的 Git 调用与路径边界
    git/                只读 Git 状态/Diff 与确定性 Commit Preview
    checkpoints/        隔离快照、生命周期、恢复确认与精确文件提交
    integrations/       MCP/Skills 只读发现、脱敏和大小限制
  preload/              contextBridge 白名单 API
  renderer/
    features/           项目、聊天、权限、设置、终端等 UI
    hooks/              项目/会话选择控制器
    stores/             按复合键隔离的运行时状态
  shared/               事件、IPC、会话和权限类型及状态机
```

## 数据与安全

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- Renderer 不能直接访问 Node.js 或 Claude 子进程
- 提示词、MCP 配置、Token、API Key、Authorization 与 Cookie 不写入日志
- Workbench 元数据保存在 Electron `userData/claude-workbench.db`，格式为 `better-sqlite3`（WAL）。表包括 `projects / sessions / messages / events / tasks / file_changes / permissions / settings / project_settings / checkpoints / checkpoint_files`
- Checkpoint 文件快照保存在 `userData/checkpoints`，不写进用户仓库；Renderer 只能看到脱敏后的索引，拿不到内部快照绝对路径
- 恢复只逐文件写入确认预览中的任务文件；不会调用 `git reset --hard`、`git clean` 或 `git checkout .`，执行前会创建 rollback checkpoint 并复查文件指纹、staged 与冲突状态
- Commit 只包含当前 run 记录的任务文件；任务外的 dirty、untracked 和 staged 用户修改保持原样，且不会自动 push
- 启动时发现旧 JSON 数据会先移动为带时间戳的 `.legacy-*.backup`，再事务导入 SQLite；启动失败会保留失败数据库备份并恢复旧数据
- 上次异常退出遗留的 `starting/running/waiting_permission` 任务会在重启时标记为已停止，不会伪装成仍在后台运行
- MCP/Skills 内容读取受真实路径 containment、symlink、UTF-8 和大小上限保护；Renderer 永远拿不到未脱敏的 MCP secret
- `FORCE_FAKE=1` 仅用于显式的本地测试；检测到真实 Claude CLI 时默认使用真实适配器

## 性能边界

- 项目任务列表只渲染可见窗口；SQLite 会话、消息和事件均提供分页 API
- Workbench 与 Claude 历史消息初次只保留最近 100 条，可继续向前分页；工作记录初次载入最近 500 条，可继续向前分页
- Monaco 及语言 worker 仅在展开 Diff 时加载；全部 Diff 使用有界并发和错误隔离
- 单文件正文超过 5000 行或 2 MiB、二进制或非 UTF-8 时不进入编辑器，提示改用外部编辑器

## 开发脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 仅启动 Renderer Vite 服务 |
| `npm run dev:electron` | 启动完整开发应用 |
| `npm run typecheck` | TypeScript 严格检查 |
| `npm test` | Vitest 全量测试 |
| `npm run test:electron:smoke` | 隔离数据目录启动真实生产 Electron 的快速检查 |
| `npm run test:electron:acceptance` | 隔离环境执行双项目、后台任务、Git/Checkpoint/恢复/Commit、Diff、MCP/Skills、命令面板和重启持久化验收 |
| `npm run lint` | ESLint 检查 |
| `npm run build` | 构建 main、permission MCP helper、preload 与 renderer |
| `npm run dist:win` | 生成 Windows 分发包 |

## License

MIT
