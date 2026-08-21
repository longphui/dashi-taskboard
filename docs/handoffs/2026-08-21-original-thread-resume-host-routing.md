# 原会话续跑 host 路由修复交接

日期：2026-08-21

## 目标

修复任务退回 `todo` 后，本地续跑 worker 无法在任务绑定的原 Codex 对话中继续执行、界面显示“交接失败”的问题。

## 结论与根因

之前实现的恢复链路仍在当前代码中：

`thread/read -> thread/unarchive -> thread/resume -> thread/read -> turn/start`

上游后来为 `requestCodexAppServerViaCdp` 新增了 `hostId` 参数，但 fork 中原会话续跑和自动化线程清理调用仍按旧参数顺序传参。实际结果是：

- `"thread/read"` 被错误地当成 `hostId`；
- 方法名、参数对象随后整体错位；
- worker 最终把错误折叠为 `Original thread is unavailable`；
- 原 thread 文件和 Codex 对话本身并未丢失。

## 真实调用路径

`任务退回 todo -> 数据库创建 task_resume_request -> runTaskResumeWorkerPass -> 读取项目 codexHostId -> thread/read/unarchive/resume -> turn/start -> 原 thread 收到续跑消息 -> 原对话认领任务`

## 已实施改动

文件：`scripts/codex-injector.mjs`

- 从现有自动化策略读取任务项目对应的 `codexHostId`。
- 为原会话的 `thread/read`、`thread/unarchive`、`thread/resume`、`turn/start` 和 `thread/turns/list` 补齐 host 路由。
- 为自动化线程清理的 `thread/list` 和 `thread/archive` 补齐 host 路由。
- 保留原有恢复顺序、沙箱策略恢复、依赖检查、公平调度和 Cloud 早退逻辑。
- 未修改 UI、数据库结构或任务状态协议。

提交：`a048cd992dc51134178d0b3db0f19d12ee25eaff fix: restore original-thread host routing`

分支：`codex/fix-task-resume-host-id`

远端：`origin/codex/fix-task-resume-host-id`

工作区：`/Volumes/work/taskboard/.worktrees/fix-task-resume-host-id`

## 验证证据

- `node --check scripts/codex-injector.mjs`：通过。
- `node --test test/injector.test.mjs`：11/11 通过。
- 完整 `npm test`：450 通过、1 跳过；唯一失败是无关测试占用固定端口 `5173`。
- 真实 CDP/App Server 调用：正确传入 `hostId=local` 后，FENLUABP-8 原 thread 可从 `notLoaded` 恢复并接收输入。
- universal macOS App 和 DMG 构建成功。
- 包内 `taskctl` 验证与 macOS secretless preflight 通过。
- 已安装 `/Applications/Codex Taskboard.app`，包内修复源码 SHA-256 为 `cbaa298a63cb3711e14f4645cc2ac2cf9f96be00c78bf4e7ac98f083dd5a7160`。
- 新安装进程已启动；worker 日志观察期间没有新增 `Taskboard original-thread resume worker pass failed`。
- FENLUABP-8 新续跑请求 `27283d4c-6360-4943-a167-bcf26ef2a031` 已为 `dispatched`，turn `01a0232f-90cd-7fd3-b394-5e914ef7951a` 已进入原 thread `019ffe53-afcd-7bc1-bc9c-b236fb3c42c9`，没有创建新对话。

## 当前状态

- 本机修复已安装并生效。
- App 版本仍显示 `1.1.2`，这是本机自定义重建，没有发布新版本。
- 修复分支已推送，尚未合并到 `main`。
- FENLUABP-8 的原对话 turn 正在处理；不要从新窗口再次发送相同续跑消息，也不要抢占或手工改动该任务状态。
- 被替换的旧 App 备份：`/private/tmp/codex-taskboard-install.3oJ54n/Codex Taskboard.app`。

## 下一步

1. 观察 FENLUABP-8 原对话完成认领和处理，确认没有新建窗口。
2. 用户确认真实体验正常后，将 `codex/fix-task-resume-host-id` 合并到 `main`。
3. 确认远端 `main` 包含 `a048cd9`，再清理隔离 worktree 和功能分支。
4. 不要把旧失败请求 `dc2a938f-de83-4f0f-ac36-750914894845` 当成当前故障；它是安装修复前保留的历史审计记录。

