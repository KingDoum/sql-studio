# SQL Studio 自动保存、工作区恢复与调试日志持久化实施方案

## 1. 文档信息

### 1.1 基本信息

- 文档状态：技术方案已定稿；S0-S6 已在 NAS 无头环境实施完成（2026-09-07），Windows 真机验收与发布包重建待 Windows 图形环境执行。
- 优先级：P0，影响数据安全、故障诊断和应用可恢复性。
- 适用项目：SQL Studio。
- 项目目录：`/vol1/1000/docker/Services/deepseek-harness/DSH_projects/sql_plus/SQL_project`。
- 适用平台：当前 Electron 桌面应用，重点验收 Windows 发布包。
- 目标读者：负责实现、测试、发布和验收的开发者。
- 编写目的：提供从基线确认到发布验收的决策完备实施规范。
- 本文不是探索性建议；除明确标注“编码前核实”的 API 细节外，技术方向不得替换。

> 📌 实施状态（2026-09-07 更新）：S0-S6 已实施并通过 NAS 无头验证
> （typecheck / 41 文件 535 用例 / build / 5 个 E2E 全绿，详见 docs/开发文档.md §8.8）。
> 剩余「已实现未验证」项：Windows Electron 真机验收、`npm run package` 重建 Windows 发布包、
> 真实崩溃路径日志样本。任何后续实施不得偏离本方案技术方向。

### 1.2 核心结论

- 工作区和恢复草稿写入现有 `userData/sql-studio.db`。
- 数据链路固定为 Renderer → preload 类型化 IPC → Main → SQLite。
- Renderer 不得直接访问 Node、SQLite 或文件系统。
- 推荐新增独立 `WorkspaceRecoveryStore`。
- `WorkspaceRecoveryStore` 与 `MetadataStore` 共用同一个 SQLite 连接和事务边界。
- 调试日志由 Main 使用 `electron-log` 写文件，不进入 SQLite。
- 自动保存保存的是恢复快照，不是用户真实 `.sql` 文件。
- 真实 `.sql` 文件仅在手动保存、`Ctrl+S` 或其他明确保存动作时写入。
- 查询结果、执行中状态、密码、API Key 永不进入工作区快照。
- 日志不得记录完整敏感 SQL。

### 1.3 事实来源

- `README.md`：项目能力、运行方式和目录入口。
- `docs/架构文档.md`：进程边界和模块职责的历史说明。
- `docs/开发文档.md`：开发约束和常用流程。
- `docs/测试与发布验收规范.md`：测试层级和发布要求。
- `src/renderer/store/workspace.ts`：当前工作区内存状态及标签操作。
- `src/renderer/App.tsx`：当前应用编排、设置持久化、脚本打开和保存入口。
- `src/renderer/lib/debug-log.ts`：当前内存调试日志实现。
- `src/renderer/components/SettingsPanel.tsx`：当前日志查看、复制和清空入口。
- `src/main/index.ts`：Main 启动和退出生命周期。
- `src/main/ipc.ts`：IPC 注册及业务处理入口。
- `src/main/services/metadata-store.ts`：SQLite 连接、表结构、版本和设置存储。
- `src/shared/types.ts`：跨进程共享业务类型。
- `src/shared/ipc-contract.ts`：IPC channel、请求和响应的唯一契约来源。
- `src/preload/index.ts`：`window.sqlStudio` 的自动暴露机制。
- `package.json`：`electron-log` 依赖版本声明为 `^5.2.0`。

### 1.4 事实解释规则

- 源码与文档冲突时，以当前源码行为为事实。
- 行号是定位提示，不是稳定 API；编码前必须用 `nl -ba` 重新确认。
- 文档中的 `electron-log` 配置目标是产品要求，不代表已核实具体 API 名称。
- 编码前必须读取本地 `node_modules/electron-log` 的类型定义和 README。
- 必须核实当前实际安装版本是否为 5.2.0 兼容版本。
- 未核实前不得凭记忆臆造 transport、rotate、archive、resolvePath 等 API。

## 2. 问题背景与用户影响

### 2.1 当前问题

- 工作区标签仅存在于 Renderer 内存。
- 应用正常重启后，未命名 SQL 草稿会丢失。
- 已打开文件上的未保存修改会丢失。
- 多标签顺序和活动标签不会恢复。
- 当前连接选择不会恢复。
- 窗口被叉掉、Renderer 白屏或进程被强杀时，没有可靠恢复面。
- 当前调试日志仅存在 Renderer 内存。
- 应用重启后日志消失。
- Renderer 崩溃后，Renderer 无法再记录自身崩溃后的信息。
- 当前日志缺少文件轮转、总量限制和保留期限。
- 当前日志清空只是清空内存数组，不涉及持久日志文件。

### 2.2 用户影响

- 用户可能丢失数分钟到数小时的 SQL 编辑内容。
- 用户不能从异常退出前的工作状态继续工作。
- 用户可能误以为“自动保存”已写回原文件，造成错误安全预期。
- 问题发生后，支持人员缺少跨重启诊断证据。
- 白屏、加载失败或 Renderer 被系统终止时，日志链路同时失效。
- 无限制日志可能占满磁盘；缺乏日志又使故障无法定位。

### 2.3 根因摘要

- 工作区状态属于临时 Zustand 状态，没有持久化边界。
- 设置存储只覆盖少量键值，不适合规范化多标签快照。
- 当前没有工作区 schema、revision、迁移和损坏隔离协议。
- 当前没有自动保存调度器、串行队列和退出 flush。
- 日志所有权在 Renderer，无法覆盖 Main 和 Renderer 崩溃路径。
- 缺少统一脱敏器和持久日志服务。

## 3. 当前实现证据与根因

### 3.1 Renderer 工作区证据

- `src/renderer/store/workspace.ts:44-52` 附近定义 `currentConnectionId`、`tabs`、`activeTabId`、`executionHistory` 和 `executing`。
- `src/renderer/store/workspace.ts:74` 附近定义 `MAX_RESULT_HISTORY = 10`。
- `src/renderer/store/workspace.ts:77-82` 附近将全部工作区状态初始化为空内存值。
- `src/renderer/store/workspace.ts:84-148` 附近实现连接切换、标签新增、打开、关闭、激活、更新和执行状态。
- `updateSql` 将标签标记为 `isDirty: true`。
- `markSaved` 更新路径并清除脏状态。
- `executionHistory` 和 `executing` 与编辑恢复数据处于同一 store，但不应持久化。
- 根因：当前 store 没有 load、hydrate、persist、flush 或 revision 语义。

### 3.2 App 编排证据

- `src/renderer/App.tsx:57` 附近持有 `debugMode` React 状态。
- `src/renderer/App.tsx:71-86` 附近通过 `settings:get` 加载主题、调试模式和字体设置。
- `src/renderer/App.tsx:95-133` 附近通过 `settings:set` 写入主题、字体和调试模式。
- `src/renderer/App.tsx:171-184` 附近持久化 `lastScriptDir`。
- `src/renderer/App.tsx:193-217` 附近执行脚本打开和保存对话框。
- `src/renderer/App.tsx:371` 附近直接将关闭事件转给 `closeTab`。
- `src/renderer/App.tsx:466` 附近将标签选择转给 `setActiveTab`。
- `src/renderer/App.tsx:575` 附近把 `debugMode` 传给设置面板。
- 根因：`App.tsx` 已承担较多编排，继续直接堆入持久化细节会扩大耦合。

### 3.3 当前调试日志证据

- `src/renderer/lib/debug-log.ts:22` 附近定义内存上限 800 条。
- `src/renderer/lib/debug-log.ts:24-31` 附近使用模块级数组追加并裁剪日志。
- `src/renderer/lib/debug-log.ts:98-99` 附近的清空只清空内存数组。
- `src/renderer/lib/debug-log.ts:107-136` 附近实现北京时间格式化和最多 500 条复制文本。
- `src/renderer/components/SettingsPanel.tsx:11-46` 附近读取、复制和清空内存日志。
- `src/renderer/components/SettingsPanel.tsx:63-69` 附近由 `debugMode` 控制日志 UI。
- 根因：日志没有进入 Main 持久层，无法跨重启，也无法覆盖 Renderer 崩溃。

### 3.4 Main 和 SQLite 证据

- `src/main/services/metadata-store.ts:23` 附近当前 `SCHEMA_VERSION = 1`。
- `src/main/services/metadata-store.ts:40` 附近启用 WAL。
- `src/main/services/metadata-store.ts:50-87` 附近创建 `meta`、`connections`、`history`、`settings`。
- `src/main/services/metadata-store.ts:268-275` 附近实现字符串设置读写。
- 现有数据库为 Electron `userData/sql-studio.db`。
- `src/main/index.ts:65` 附近在 `app.whenReady()` 后初始化服务。
- `src/main/index.ts:113-125` 附近在 `will-quit` 等待连接关闭，带约 3 秒上限。
- 当前未见工作区 store 和持久日志服务接入生命周期。
- 根因：数据库能力存在，但缺少工作区专用规范化模型和服务接口。

### 3.5 IPC 和 preload 证据

- `src/shared/ipc-contract.ts:34-93` 附近定义 `IPC_CHANNELS` 和 channel 联合类型。
- `src/shared/ipc-contract.ts:137-142` 附近定义设置请求。
- `src/shared/ipc-contract.ts:192-197` 附近定义设置响应。
- `src/main/ipc.ts:87-342` 附近按契约注册现有 handler。
- `src/main/ipc.ts:307-308` 附近处理通用设置读写。
- `src/preload/index.ts:9-47` 附近按 `IPC_CHANNELS` 自动构造并暴露 `window.sqlStudio`。
- preload 会解包统一的 `{ ok, data/error }` 响应。
- 根因：新增能力必须先进入共享契约，不能在 Renderer 临时绕过。

### 3.6 文档与源码偏差

- 架构文档关于设置面板职责的部分描述已落后于源码。
- 主题和字体当前由外观相关组件负责，不能按旧文档重新塞回设置面板。
- Main 顶部注释中的 handler 数量与其他文档口径可能不同。
- 实施者不得为修正文档偏差扩大本任务范围。
- 本方案中的文件定位仅服务于本功能实现。

## 4. 目标、非目标与术语

### 4.1 目标

- 自动持久化可恢复的标签工作区。
- 在正常重启和非正常退出后恢复最近有效状态。
- 保持标签顺序、活动标签和当前连接选择。
- 准确恢复每个标签的脏状态。
- 确保自动保存永不静默覆盖原 `.sql` 文件。
- 将 Main 和 Renderer 诊断日志持久化到受控文件。
- 提供最近 500 条日志读取、复制和清空能力。
- 提供轮转、总量、保留期限和脱敏策略。
- 保证恢复失败不会导致应用白屏。
- 保证持久化失败不阻塞 SQL 编辑 UI。

### 4.2 非目标

- 不保存查询结果集。
- 不保存 `executionHistory`。
- 不保存 `execution`。
- 不保存 `executing`。
- 不保存数据库密码。
- 不保存 API Key。
- 不保存 Authorization 或 Bearer 凭据。
- 不做多窗口协同编辑。
- 不做云同步。
- 不做版本控制替代品。
- 不把自动保存解释为文件保存。
- 不通过删除 `sql-studio.db` 或整个 `userData` 处理损坏。

### 4.3 术语

- 工作区：标签集合、顺序、活动标签和当前连接选择。
- 恢复草稿：为故障恢复保存的 SQL 内容副本。
- 真实文件：用户磁盘上的 `.sql` 文件。
- 结构事件：新增、关闭、切换、打开文件、手动保存、连接切换等事件。
- 内容事件：编辑器 SQL 内容变化。
- 快照：某一 revision 下完整且一致的可恢复工作区。
- revision：Renderer 生成的单调递增逻辑版本。
- generation：调度器内部用于识别最新待保存状态的序号。
- hydrate：把已验证快照应用到 Renderer store。
- flush：等待当前最新待保存状态完成持久化。
- 脏标签：内存 SQL 与最后明确保存到真实文件的内容不一致。
- 坏记录：不能解析、违反约束或无法安全迁移的数据行。

## 5. 用户故事与产品验收口径

### 5.1 草稿恢复

- 作为用户，我创建未命名标签并输入 SQL 后重启应用，内容应恢复。
- 恢复后的未命名标签仍显示为未命名，且 `isDirty = true`。
- 空白未命名草稿可以保留，但受容量清理策略限制。
- 自动保存不得弹出文件保存对话框。
- 自动保存不得创建或覆盖任何 `.sql` 文件。

### 5.2 文件标签恢复

- 作为用户，我打开真实 `.sql` 文件后重启，标签应按原顺序恢复。
- 若标签内容与磁盘文件一致，恢复后应为非脏。
- 若标签有未保存修改，恢复草稿优先展示，恢复后应为脏。
- 恢复 UI 必须清楚保留原 `filePath`，但不能自动写回。
- 用户手动保存后，才把恢复内容写入真实文件并清除脏状态。

### 5.3 关闭标签

- 用户请求关闭脏标签时，必须维持现有关闭确认流程。
- 用户取消关闭时，标签和恢复记录都必须保留。
- 用户确认放弃后，才允许从工作区快照删除该标签。
- 用户选择保存后关闭时，必须先完成真实文件保存，再删除恢复记录。
- 真实文件保存失败时不得关闭标签，不得删除恢复记录。
- 非脏标签确认关闭后可以立即从下一快照删除。

### 5.4 异常退出

- 窗口叉掉前应尝试 flush，但不能依赖 flush 才有恢复能力。
- Renderer 白屏时，应恢复到最后一次成功快照。
- Renderer 被强杀时，最多损失尚未完成 500ms 防抖和写队列的最新输入。
- Main 崩溃时，SQLite 已提交事务仍应保持一致。
- 工作区恢复失败时，应用必须启动空工作区而不是白屏。

### 5.5 日志

- 应用重启后，之前的持久日志仍可读取。
- Renderer 崩溃信息必须由 Main 写入。
- `warn` 和 `error` 必须即时发送和尽快落盘。
- `log` 和 `info` 仅在 `debugMode` 开启时由 Renderer 采集。
- Main 自启动起始终采集关键生命周期和崩溃日志。
- 日志展示和复制统一使用北京时间。
- 用户可读取最近 500 条、复制并通过 Main 清空。
- 日志中不得出现明文密码、API Key、Bearer token、连接串或完整敏感 SQL。

## 6. 总体架构、进程边界与数据流

### 6.1 总体架构图

```text
┌──────────────────────── Renderer ────────────────────────┐
│ Zustand workspace                                        │
│   ├─ tabs / activeTabId / currentConnectionId            │
│   └─ execution / results / executing（仅内存）            │
│                                                          │
│ workspace-persistence                                    │
│   ├─ 500ms debounce                                      │
│   ├─ serial queue / latest-wins / retry                  │
│   └─ hydrate / flush                                     │
│                                                          │
│ debug-log bridge                                         │
│   ├─ warn/error immediate                                │
│   └─ debug log/info batch                                │
└───────────────────────┬──────────────────────────────────┘
                        │ window.sqlStudio 类型化 API
┌───────────────────────▼──────────────────────────────────┐
│ preload / contextBridge / ipcRenderer.invoke             │
└───────────────────────┬──────────────────────────────────┘
                        │ typed IPC
┌───────────────────────▼────────── Main ──────────────────┐
│ ipc handlers                                             │
│   ├─ workspace:load/save/clear                           │
│   └─ logs:append/read/clear                              │
│                                                          │
│ WorkspaceRecoveryStore ── shared SQLite connection       │
│ PersistentLogService ─── electron-log file transport     │
└──────────────────┬──────────────────────┬─────────────────┘
                   │                      │
        userData/sql-studio.db       userData/logs/*
```

### 6.2 进程职责

- Renderer 负责生成当前可恢复状态。
- Renderer 负责调度防抖、latest-wins 和 UI 非阻塞行为。
- Renderer 不负责数据库路径、SQL 事务或日志文件路径。
- preload 只暴露白名单 channel，并保持类型化调用。
- Main 负责校验 IPC 输入。
- Main 负责 revision 条件写入和事务原子性。
- Main 负责数据库迁移和坏记录隔离。
- Main 负责日志落盘、轮转、读取和清空。
- Main 负责捕获 Electron 生命周期和崩溃事件。

### 6.3 工作区保存数据流

1. 用户修改 SQL。
2. workspace store 更新内存内容并设置 `isDirty = true`。
3. 持久化协调器记录新的 generation。
4. 内容事件重新启动 500ms 防抖计时器。
5. 计时器触发后，协调器构造纯数据快照。
6. 协调器分配单调递增 revision。
7. 请求进入单消费者串行队列。
8. preload 调用 `workspace:save`。
9. Main 校验 schema、容量和字段。
10. Main 在同一 SQLite 事务内 upsert 快照并替换 tab 子表。
11. Main 仅在 incoming revision 更新时提交。
12. Renderer 记录已确认 revision。
13. 若保存期间状态又变化，队列立即继续保存最新 generation。

### 6.4 日志数据流

1. Main 在应用初始化最早可行阶段初始化持久日志服务。
2. Main 记录启动、窗口、IPC、崩溃和退出摘要。
3. Renderer 日志先经过结构化和脱敏入口。
4. `warn/error` 立即调用 `logs:append`。
5. debugMode 开启时，`log/info` 进入短批次缓冲。
6. 达到批量阈值或时间阈值后发送。
7. Main 再次执行脱敏和大小限制。
8. Main 使用核实后的 electron-log v5.2.0 API 写入文件。
9. 设置面板通过 `logs:read` 获取最近 500 条。
10. `logs:clear` 由 Main 执行，仅操作服务自身管理的日志目标。

## 7. 工作区与草稿持久化产品规则

### 7.1 持久化字段白名单

- 工作区 `schemaVersion`。
- 工作区 `revision`。
- 工作区 `activeTabId`。
- 工作区 `currentConnectionId`。
- 工作区 `createdAt`。
- 工作区 `updatedAt`。
- 标签 `id`。
- 标签 `tabOrder`。
- 标签 `title`。
- 标签 `filePath`。
- 标签 `sqlContent`。
- 标签 `isDirty`。
- 标签 `connectionId`，若现有标签模型支持标签级连接。
- 标签 `createdAt`。
- 标签 `updatedAt`。

### 7.2 明确禁止持久化字段

- `execution`。
- `executionHistory`。
- 结果行 `rows`。
- 结果列元数据，除非未来单独立项。
- `executing`。
- 查询进度。
- 取消令牌。
- 数据库密码。
- API Key。
- Authorization header。
- Bearer token。
- 临时认证信息。
- 完整连接串。

### 7.3 自动保存与真实文件保存的边界

- 自动保存仅更新 SQLite 恢复快照。
- 自动保存草稿不等于保存到原 `.sql`。
- 任何自动保存逻辑都不得调用 `script:save`。
- 任何自动保存逻辑都不得调用文件保存对话框。
- 任何自动保存逻辑都不得改变磁盘文件 mtime。
- 手动保存成功后，才将标签标记为非脏。
- 手动保存成功后，应立即排队保存新的非脏恢复快照。
- 手动保存失败后，标签保持脏，恢复快照继续保留。

### 7.4 标签状态机

```text
[不存在]
   │ 新建
   ▼
[未命名-空白-脏] ──输入──> [未命名-有内容-脏]
   │                           │
   │ 明确关闭并放弃            │ 手动保存成功
   ▼                           ▼
[删除恢复记录]             [有路径-非脏]
                                │
                                │ 编辑
                                ▼
                           [有路径-脏]
                                │
               ┌────────────────┼────────────────┐
               │手动保存成功     │关闭取消         │关闭并放弃
               ▼                ▼                ▼
          [有路径-非脏]      [有路径-脏]      [删除恢复记录]
```

### 7.5 工作区恢复状态机

```text
[应用启动]
   │
   ▼
[Main 服务就绪]
   │
   ▼
[Renderer 请求 workspace:load]
   │
   ├─无数据──────────────> [启动空工作区]
   │
   ├─有效数据────────────> [迁移/校验] -> [hydrate] -> [允许自动保存]
   │
   ├─部分坏 tab──────────> [隔离坏 tab] -> [恢复其余 tab] -> [记录告警]
   │
   └─快照不可用──────────> [隔离快照] -> [启动空工作区] -> [记录错误]
```

### 7.6 事件与保存策略表

| 事件 | 内存动作 | 保存策略 | 脏状态规则 | 文件系统动作 |
| --- | --- | --- | --- | --- |
| SQL 输入 | 更新 `sqlContent` | 500ms 防抖 | 设为脏 | 无 |
| 新建标签 | 新增并激活 | 立即排队 | 新标签为脏 | 无 |
| 打开文件 | 新增或激活 | 立即排队 | 与磁盘内容一致时非脏 | 仅明确打开读取 |
| 标签切换 | 更新 activeTabId | 立即排队 | 不变 | 无 |
| 标签重排 | 更新 tabOrder | 立即排队 | 不变 | 无 |
| 连接切换 | 更新 connectionId | 立即排队 | 不变 | 无 |
| 手动保存成功 | 更新路径和基线 | 立即排队 | 清除脏 | 明确写文件 |
| 手动保存失败 | 保持原状态 | 立即重试快照 | 保持脏 | 文件写入失败 |
| 关闭非脏标签 | 删除标签 | 立即排队 | 不适用 | 无 |
| 关闭脏标签取消 | 不删除 | 可不保存或合并 | 保持脏 | 无 |
| 关闭脏标签并保存 | 保存后删除 | 两个结构事件 | 保存后关闭 | 明确写文件 |
| 关闭脏标签并放弃 | 删除标签 | 立即排队 | 删除记录 | 无 |
| 窗口关闭 | 停止接收新事件 | flush | 不变 | 无 |
| Renderer 崩溃 | 无法继续 | 使用上次提交 | 不变 | Main 写日志 |

### 7.7 主动关闭脏标签规则

- 关闭前仍维持现有确认。
- “取消”不能修改工作区。
- “保存”必须等待真实文件写入成功。
- “不保存/放弃”是删除恢复记录的明确授权。
- 用户明确关闭脏标签后，该标签恢复记录才删除。
- 不允许在用户看到确认框时预先删除快照行。
- 不允许把“窗口退出”默认等同于“放弃所有脏标签”。

## 8. SQLite 数据模型

### 8.1 选型结论

- 采用 `workspace_snapshots` 单行工作区表。
- 采用 `workspace_tabs` 规范化标签子表。
- 不把整个标签数组仅作为一个 JSON blob 存储。
- 规范化模型便于逐行校验、隔离坏标签、容量统计和迁移。
- 工作区级字段和标签级字段分离。
- 保存时仍采用完整快照替换语义，减少增量事件重放复杂度。
- 推荐独立 `WorkspaceRecoveryStore`。
- 推荐把同一个 `better-sqlite3` Database 实例注入该 store。
- 不推荐为工作区另开一个 SQLite 连接。
- 共用连接可保证 schema 迁移、事务、关闭和 PRAGMA 策略一致。

### 8.2 建议 DDL

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  active_tab_id TEXT NULL,
  current_connection_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(workspace_id) BETWEEN 1 AND 128),
  CHECK (length(created_at) BETWEEN 20 AND 64),
  CHECK (length(updated_at) BETWEEN 20 AND 64)
);

CREATE TABLE IF NOT EXISTS workspace_tabs (
  workspace_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  tab_order INTEGER NOT NULL CHECK (tab_order >= 0),
  title TEXT NOT NULL,
  file_path TEXT NULL,
  sql_content TEXT NOT NULL DEFAULT '',
  is_dirty INTEGER NOT NULL CHECK (is_dirty IN (0, 1)),
  connection_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tab_id),
  UNIQUE (workspace_id, tab_order),
  FOREIGN KEY (workspace_id)
    REFERENCES workspace_snapshots(workspace_id)
    ON DELETE CASCADE,
  CHECK (length(tab_id) BETWEEN 1 AND 128),
  CHECK (length(title) <= 512),
  CHECK (file_path IS NULL OR length(file_path) <= 32768)
);

CREATE INDEX IF NOT EXISTS idx_workspace_tabs_workspace_order
  ON workspace_tabs(workspace_id, tab_order);

CREATE INDEX IF NOT EXISTS idx_workspace_tabs_updated_at
  ON workspace_tabs(updated_at);
```

### 8.3 单工作区约定

- 当前只使用固定 `workspace_id = 'default'`。
- 保留 `workspace_id` 是为未来多窗口或多工作区迁移留出边界。
- 当前不得实现多工作区 UI。
- `active_tab_id` 可以为空。
- `current_connection_id` 可以为空。
- `active_tab_id` 必须在加载后验证是否指向有效标签。
- 不建议给 `active_tab_id` 建跨表外键，以避免替换标签时的更新顺序复杂度。

### 8.4 事务保存规范

```sql
BEGIN IMMEDIATE;

INSERT INTO workspace_snapshots (
  workspace_id,
  schema_version,
  revision,
  active_tab_id,
  current_connection_id,
  created_at,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  schema_version = excluded.schema_version,
  revision = excluded.revision,
  active_tab_id = excluded.active_tab_id,
  current_connection_id = excluded.current_connection_id,
  updated_at = excluded.updated_at
WHERE excluded.revision > workspace_snapshots.revision;

-- 仅当上一步确实接受 incoming revision 时继续替换子表。
DELETE FROM workspace_tabs WHERE workspace_id = ?;

-- 按 tab_order 逐条插入已验证标签。
INSERT INTO workspace_tabs (
  workspace_id,
  tab_id,
  tab_order,
  title,
  file_path,
  sql_content,
  is_dirty,
  connection_id,
  created_at,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

COMMIT;
```

### 8.5 revision 条件的实现要求

- 不能只依赖 Renderer 串行队列。
- Main 必须拒绝 `incomingRevision <= storedRevision` 的保存。
- 拒绝旧 revision 时返回当前持久化 revision，而不是抛出致命错误。
- `DELETE workspace_tabs` 只能在确认新 revision 被接受后执行。
- 推荐在 JavaScript 事务函数中先读取 revision，再决定是否替换。
- 不得出现旧请求先慢后到、覆盖新状态的可能。

### 8.6 清空事务

```sql
BEGIN IMMEDIATE;
DELETE FROM workspace_snapshots WHERE workspace_id = 'default';
COMMIT;
```

- 依赖 `ON DELETE CASCADE` 删除标签子表。
- `workspace:clear` 只清工作区表。
- `workspace:clear` 不得删除数据库文件。
- `workspace:clear` 不得清连接、历史或设置。
- `workspace:clear` 不得清整个 `userData`。

### 8.7 数据库版本迁移

- 当前数据库 `SCHEMA_VERSION = 1`。
- 引入工作区表时建议迁移为数据库 schema version 2。
- 迁移必须在事务中执行。
- `CREATE TABLE IF NOT EXISTS` 不能替代明确版本迁移记录。
- 迁移前记录当前版本。
- 迁移后更新 `meta` 中版本。
- 迁移失败时回滚事务。
- 迁移失败不得删除旧数据库。
- 应用应记录诊断日志并进入受控降级。

### 8.8 容量策略

- 单标签 SQL UTF-8 字节上限建议 2 MiB。
- 单工作区全部 SQL UTF-8 字节上限建议 20 MiB。
- 标签数量上限建议 100。
- title 上限 512 字符。
- filePath 上限 32768 字符。
- 超限时不得阻塞编辑。
- 超限时保存请求返回结构化失败原因。
- UI 显示非阻塞告警，并保留内存内容。
- 容量清理只能清理被确认关闭的标签或明确过期的孤立坏记录。
- 当前单快照模型不得静默丢弃仍打开的标签。

## 9. TypeScript 共享类型与 IPC 契约

### 9.1 工作区共享类型

```ts
export interface WorkspaceTabSnapshot {
  id: string;
  tabOrder: number;
  title: string;
  filePath: string | null;
  sqlContent: string;
  isDirty: boolean;
  connectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  workspaceId: 'default';
  schemaVersion: number;
  revision: number;
  activeTabId: string | null;
  currentConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
  tabs: WorkspaceTabSnapshot[];
}

export interface WorkspaceLoadResult {
  snapshot: WorkspaceSnapshot | null;
  recoveredTabCount: number;
  quarantinedTabCount: number;
  warnings: string[];
}

export interface WorkspaceSaveRequest {
  snapshot: WorkspaceSnapshot;
}

export interface WorkspaceSaveResult {
  saved: boolean;
  acceptedRevision: number;
  storedRevision: number;
  reason?: 'saved' | 'stale-revision' | 'capacity-exceeded';
}

export interface WorkspaceClearRequest {
  workspaceId: 'default';
  expectedRevision?: number;
}

export interface WorkspaceClearResult {
  cleared: boolean;
}
```

### 9.2 日志共享类型

```ts
export type PersistentLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PersistentLogEntryInput {
  timestamp: string;
  level: PersistentLogLevel;
  source: 'main' | 'renderer';
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface PersistentLogEntry extends PersistentLogEntryInput {
  id: string;
}

export interface LogsAppendRequest {
  entries: PersistentLogEntryInput[];
  flush: boolean;
}

export interface LogsAppendResult {
  accepted: number;
  dropped: number;
}

export interface LogsReadRequest {
  limit?: number;
}

export interface LogsReadResult {
  entries: PersistentLogEntry[];
  timezone: 'Asia/Shanghai';
  truncated: boolean;
}

export interface LogsClearRequest {
  scope: 'all-managed-logs';
}

export interface LogsClearResult {
  cleared: boolean;
  removedFileCount: number;
}
```

### 9.3 建议 IPC channels

```ts
'workspace:load': 'workspace:load',
'workspace:save': 'workspace:save',
'workspace:clear': 'workspace:clear',
'logs:append': 'logs:append',
'logs:read': 'logs:read',
'logs:clear': 'logs:clear',
```

### 9.4 请求映射

```ts
'workspace:load': { workspaceId: 'default' };
'workspace:save': WorkspaceSaveRequest;
'workspace:clear': WorkspaceClearRequest;
'logs:append': LogsAppendRequest;
'logs:read': LogsReadRequest;
'logs:clear': LogsClearRequest;
```

### 9.5 响应映射

```ts
'workspace:load': WorkspaceLoadResult;
'workspace:save': WorkspaceSaveResult;
'workspace:clear': WorkspaceClearResult;
'logs:append': LogsAppendResult;
'logs:read': LogsReadResult;
'logs:clear': LogsClearResult;
```

### 9.6 请求响应示例

```json
{
  "channel": "workspace:save",
  "request": {
    "snapshot": {
      "workspaceId": "default",
      "schemaVersion": 1,
      "revision": 42,
      "activeTabId": "tab-2",
      "currentConnectionId": "conn-1",
      "createdAt": "2026-09-07T01:00:00.000Z",
      "updatedAt": "2026-09-07T01:05:00.000Z",
      "tabs": []
    }
  },
  "response": {
    "saved": true,
    "acceptedRevision": 42,
    "storedRevision": 42,
    "reason": "saved"
  }
}
```

```json
{
  "channel": "logs:append",
  "request": {
    "flush": true,
    "entries": [
      {
        "timestamp": "2026-09-07T01:05:01.000Z",
        "level": "error",
        "source": "renderer",
        "event": "query.failed",
        "message": "Query failed",
        "context": {
          "queryId": "q-123",
          "sqlLength": 184,
          "sqlHash": "sha256:...",
          "status": "failed"
        }
      }
    ]
  }
}
```

### 9.7 契约约束

- 所有 channel 必须加入 `IPC_CHANNELS`。
- 所有 request 必须加入 `IpcRequestMap`。
- 所有 response 必须加入 `IpcResponseMap`。
- Main handler 必须使用统一 `handle` 包装。
- preload 继续通过 channel 枚举自动暴露。
- 不新增 `ipcRenderer` 直通对象。
- 不新增 `any` 逃逸契约。
- IPC 输入要做运行时校验，不能只依赖 TypeScript。
- `logs:read.limit` 强制夹在 1 到 500。
- `logs:append.entries` 设置批量条数和总字节限制。

### 9.8 契约测试

- 测试所有新增 channel 同时存在于请求和响应映射。
- 测试 preload 自动暴露新增 channel。
- 测试 Main 已注册所有新增 handler。
- 测试非法 revision 被拒绝。
- 测试过大日志批次被限制。
- 测试未知字段不会造成路径或 SQL 注入。
- 测试统一错误格式仍被 preload 正确解包。

## 10. 自动保存调度算法

### 10.1 调度要求

- SQL 内容编辑使用 500ms trailing debounce。
- 新建、关闭、切换、重排、文件打开、手动保存和连接切换立即排队。
- 同一时刻最多一个 `workspace:save` 在途。
- 保存请求按串行队列执行。
- 中间过时状态可以合并跳过。
- 最终最新状态必须被保存。
- Renderer 使用 generation 判断保存期间是否又发生变化。
- 每次实际发送分配递增 revision。
- Main 用 revision 防止旧请求覆盖新状态。

### 10.2 建议伪代码

```ts
class WorkspacePersistenceCoordinator {
  private generation = 0;
  private persistedGeneration = 0;
  private nextRevision = 1;
  private running = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private stopped = false;

  onContentChanged(): void {
    this.generation += 1;
    this.resetDebounce(500);
  }

  onStructuralChanged(): void {
    this.generation += 1;
    this.cancelDebounce();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      while (this.persistedGeneration < this.generation) {
        const targetGeneration = this.generation;
        const snapshot = this.buildSnapshot(this.nextRevision++);

        try {
          const result = await window.sqlStudio['workspace:save']({ snapshot });
          this.acceptResult(result);
          this.persistedGeneration = targetGeneration;
          this.retryAttempt = 0;
        } catch (error) {
          this.retryAttempt += 1;
          await this.waitWithBackoff(this.retryAttempt);
          if (this.retryAttempt >= MAX_RETRIES) break;
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.persistedGeneration < this.generation) {
        this.scheduleRetry();
      }
    }
  }

  async flush(deadlineMs: number): Promise<FlushResult> {
    this.cancelDebounce();
    void this.drain();
    return this.waitUntilPersistedOrDeadline(deadlineMs);
  }
}
```

### 10.3 latest-wins 规则

- generation 每次相关状态变化都递增。
- 队列不为每个键击保留独立快照。
- 在途保存不可取消时，等待其完成。
- 在途保存完成后直接构造最新状态快照。
- 不发送已经被更新状态取代的中间 generation。
- `persistedGeneration` 只能在 Main 接受或确认更高 revision 后推进。
- Main 返回 stale revision 且 stored revision 更高时可视为状态已被更高版本覆盖。

### 10.4 重试规则

- 首次失败后约 250ms 重试。
- 第二次失败后约 1s 重试。
- 第三次失败后约 4s 重试。
- 自动连续重试最多 3 次。
- 加入小幅 jitter，避免多个事件同步重试。
- 达到上限后显示非阻塞告警。
- 后续用户编辑或结构事件可重新触发保存。
- 应记录错误类型、revision、tabCount 和总字节，不记录完整 SQL。

### 10.5 退出 flush

- Renderer 在窗口允许关闭的生命周期中调用 flush。
- flush 截止时间建议 1500ms，并与 Main 总退出窗口协调。
- Main 的 `will-quit` 不应无限等待 Renderer。
- Main 应在退出前完成日志服务自身的 flush/close。
- 不得把退出 flush 当作唯一数据安全机制。
- 强杀场景只能依赖此前持续自动保存。
- flush 超时应记录日志并继续退出，避免应用卡死。

### 10.6 背压

- 日志和工作区使用独立队列，避免相互阻塞。
- 工作区队列保留最新快照，不积压每次键击。
- 日志 debug/info 批量缓冲有条数和字节上限。
- 日志 warn/error 可抢先触发批量发送。
- Main IPC handler 必须限制单请求大小。
- 超限日志应丢弃或截断 context，并记录计数摘要。
- 工作区超限不得静默截断 SQL 内容。

## 11. 启动恢复、关闭、崩溃、损坏与迁移

### 11.1 首次启动无数据

- `workspace:load` 返回 `snapshot: null`。
- Renderer 创建当前产品默认空工作区。
- 不把“无数据”记录为错误。
- 首个结构或内容事件后开始保存。

### 11.2 正常重启

- Main 先完成数据库迁移和服务初始化。
- Renderer 在默认标签创建前请求恢复。
- 恢复成功后一次性 hydrate。
- hydrate 期间禁止触发自动保存。
- hydrate 完成后设置 revision 起点为 `storedRevision + 1`。
- 再开启订阅和保存调度。

### 11.3 窗口叉掉

- 保持现有脏标签确认语义。
- 窗口关闭事件发起短时 flush。
- 若用户取消关闭，继续正常编辑和保存。
- 若用户确认退出，不删除仍打开的脏标签恢复记录。
- “退出应用”不等于“放弃草稿”。

### 11.4 强杀、崩溃和白屏

- 强杀后恢复最后成功提交 revision。
- Main 监听 Renderer 崩溃事件并写持久日志。
- Renderer 已崩溃时仍由 Main 写入崩溃日志。
- 白屏恢复失败不得循环崩溃。
- 恢复异常必须在错误边界外层被捕获。
- 失败后启动空工作区并保留诊断日志。

### 11.5 多标签

- 恢复严格按 `tabOrder` 排序。
- `tabOrder` 必须从 0 连续重建，或加载时规范化。
- 重复 `tabOrder` 视为坏数据。
- 重复 `tabId` 视为坏数据。
- 无效 `activeTabId` 回退到第一个有效标签。
- 无标签时 `activeTabId = null`。

### 11.6 未命名标签与空白草稿

- 未命名标签 `filePath = null`。
- 未命名标签默认 `isDirty = true`。
- 空字符串是合法 `sqlContent`。
- 空白草稿不是损坏数据。
- 容量清理不得在标签仍打开时自动删除空白草稿。

### 11.7 外部文件改动或删除

- 快照应保留恢复时看到的 `filePath` 和草稿内容。
- 恢复时可以由 Main 获取文件 stat 摘要，但不得自动写文件。
- 文件已删除时仍恢复为脏标签，并标记路径不可用。
- 文件外部变更且草稿非脏时，可提示重新加载磁盘版本。
- 文件外部变更且草稿为脏时，必须提示冲突。
- 冲突时不得静默选择任一版本覆盖另一版本。
- 若要可靠比较，后续实现可保存“最后明确保存内容的 hash/mtime/size”元数据。
- 该元数据不得改变“草稿不覆盖文件”的原则。

### 11.8 当前连接失效

- `currentConnectionId` 只保存标识，不保存凭据。
- 恢复后必须与现有连接列表核对。
- 已删除或不可用连接回退为 `null`。
- 标签级失效连接也回退为 `null` 或显示失效状态。
- 连接失效不得阻止 SQL 文本恢复。
- 不得因连接失效删除标签。

### 11.9 损坏 JSON 与损坏行

- 规范化表避免把全部标签放入单个 JSON。
- context 等扩展字段若使用 JSON，解析必须逐行 try/catch。
- 单个标签损坏时隔离该标签并恢复其余标签。
- 工作区主行损坏时隔离该快照并启动空工作区。
- 隔离可以写入专用 quarantine 表，或记录行标识和错误后跳过。
- 不得在恢复请求中把原始完整 SQL 写入日志。
- 不得因一行坏数据删除整个数据库。

### 11.10 版本迁移

- 先迁移数据库 schema，再加载工作区 schema。
- 工作区 `schemaVersion` 与数据库 schema version 分开管理。
- 每个工作区版本迁移函数必须是单向、可测试和幂等的。
- 遇到未来未知版本时不得强行解析。
- 未知版本应隔离并启动空工作区。
- 降级应用不得覆盖由新版本写入的未知快照。

### 11.11 保存失败

- SQLite busy、磁盘满、权限错误和校验错误分别分类。
- UI 编辑继续可用。
- 显示简洁的持久化失败状态。
- 日志记录错误码、revision、大小和重试次数。
- 不记录 SQL 正文。
- 恢复保存后清除告警。

## 12. 持久日志方案

### 12.1 服务归属

- 新增 `PersistentLogService`，运行在 Main。
- 该服务封装 electron-log，避免业务代码散落 transport 配置。
- Renderer 只发送结构化日志条目。
- Main 日志可直接调用服务，不经过 Renderer IPC。
- 读取和清空必须通过 Main IPC。

### 12.2 electron-log v5.2.0 编码前核实门

- `package.json` 当前声明 `electron-log: ^5.2.0`。
- 执行者必须读取本地锁文件确认实际解析版本。
- 执行者必须读取 `node_modules/electron-log` README。
- 执行者必须读取主入口和相关 `.d.ts` 类型定义。
- 必须核实 Main 入口导入方式。
- 必须核实 file transport 的启用和级别配置方式。
- 必须核实日志路径解析方式。
- 必须核实单文件大小限制和轮转/归档钩子。
- 必须核实 flush、文件读取和 clear 是否有官方能力。
- 若无官方 clear API，必须由服务基于已解析的受控路径实现。
- 不得凭印象使用旧版 electron-log API。
- API 核实结果必须在 S4 阶段报告中列出来源文件和实际签名。

### 12.3 Main 采集范围

- 应用进程启动。
- `app.whenReady()` 成功或失败。
- 数据库迁移成功或失败。
- BrowserWindow 创建、ready、close 和 closed 摘要。
- `render-process-gone`。
- `unresponsive`。
- `responsive`。
- `did-fail-load`。
- `uncaughtException`。
- `unhandledRejection`。
- IPC handler 结构化失败。
- 工作区 load/save/clear 结果摘要。
- 工作区恢复隔离数量。
- 日志轮转和清空结果。
- 应用退出和 flush 超时。

### 12.4 Renderer 采集范围

- 工作区恢复开始、成功、降级和失败。
- 自动保存重试和最终失败。
- 手动打开、保存的状态摘要。
- 查询开始、成功、失败和取消摘要。
- 设置加载失败。
- React 错误边界捕获。
- 用户可诊断的 UI 异常。
- 不记录编辑器 SQL 正文。
- 不记录查询结果行。

### 12.5 级别规则

- `error`：功能失败、崩溃、数据损坏、迁移失败。
- `warn`：降级、重试、失效连接、部分恢复、容量临界。
- `info`：关键生命周期和用户明确操作摘要。
- `debug`：高频诊断细节，仅在 debugMode 下采集 Renderer 来源。
- Main 的关键崩溃和生命周期日志不受 Renderer debugMode 关闭影响。
- 生产环境默认不输出 Renderer debug 明细。

### 12.6 批量与即时发送

- Renderer `warn/error` 创建后立即发送。
- 若批量缓冲已有 `debug/info`，可一起带上。
- Renderer `log/info` 在 debugMode 开启时进入缓冲。
- 建议批量阈值：20 条或 250ms，先到者触发。
- 单批最多 100 条。
- 单条序列化后建议不超过 32 KiB。
- 单批序列化后建议不超过 256 KiB。
- 页面隐藏、刷新和关闭前尝试 flush。
- IPC 失败不得递归调用同一日志入口。

### 12.7 文件位置与路径约束

- 日志位于 Electron `userData` 下由服务控制的日志目录。
- 具体路径通过核实后的 electron-log API 解析。
- UI 不接收任意日志路径参数。
- `logs:read` 不接收文件名或路径。
- `logs:clear` 不接收文件名或路径。
- Main 只操作自身解析并登记的受控日志文件。
- 清空前后都要校验真实路径位于受控目录内。
- 禁止 `../`、绝对路径和符号链接逃逸。

### 12.8 轮转、总量和保留期限

- 产品目标：活动日志文件建议上限 10 MiB。
- 产品目标：最多保留 5 个归档文件。
- 产品目标：保留期限 14 天。
- 产品目标：日志目录总量硬上限 60 MiB。
- 每次应用启动执行轻量清理。
- 每次轮转后执行保留数量和期限清理。
- 总量超过硬上限时优先删除最旧归档。
- 当前活动文件最后删除，且只在官方机制允许时处理。
- 具体实现必须映射到 v5.2.0 已核实 API。
- 若 electron-log 内建能力不足，补充受控文件维护逻辑并测试。

### 12.9 最近 500 条读取

- `logs:read` 默认和最大均为 500 条。
- Main 从受控活动和归档文件读取末尾记录。
- 读取应从新到旧选择必要文件，避免扫描全部历史。
- 返回给 UI 时按时间升序或明确稳定顺序。
- 解析失败行作为损坏日志行计数，不让整个请求失败。
- UI 展示统一转换为 `Asia/Shanghai`。
- 原始存储建议保留 UTC ISO 时间。
- 复制文本头部注明“北京时间”。

### 12.10 清空和复制

- “清空日志”按钮调用 `logs:clear`。
- Main 清空受控活动和归档日志。
- 清空动作本身可在清空后写入一条新的审计摘要。
- UI 成功后刷新列表。
- 清空失败时保留现有显示并提示。
- “复制”基于 `logs:read` 返回的最近 500 条。
- 复制前再进行一次展示层脱敏。
- 复制失败不得影响持久日志。

### 12.11 脱敏规则

- Renderer 发送前执行第一层脱敏。
- Main 写文件前执行第二层脱敏。
- 读取返回前可执行第三层兜底脱敏。
- 键名匹配 `password`、`passwd`、`pwd` 时值替换为 `[REDACTED]`。
- 键名匹配 `apiKey`、`api_key`、`secret` 时值替换为 `[REDACTED]`。
- 键名匹配 `authorization`、`token`、`accessToken`、`refreshToken` 时替换。
- 文本中的 `Bearer <value>` 替换为 `Bearer [REDACTED]`。
- URL 中的用户名、密码和敏感 query 参数替换。
- 数据库连接串只允许记录 driver、host 是否存在、数据库名 hash 等摘要。
- SQL 只记录 `sqlLength`、`sqlHash`、`queryId`、`status`、`durationMs`。
- 不记录完整 SQL。
- 不记录 SQL 前 N 个字符，因为其中仍可能包含敏感值。
- 不记录查询结果 rows。
- Error 对象需清洗 message、stack 和自定义字段。
- 循环引用对象必须安全序列化。

### 12.12 console 包装与递归风险

- 不允许简单重写 console 后在日志服务内部继续调用被重写的 console。
- 若需要捕获 console，保存原始函数引用。
- 持久日志写入失败时使用独立故障通道或原始 stderr。
- 设置重入 guard，避免日志写入错误再次触发日志写入。
- 同一错误在短时间内进行去重或采样。
- Renderer bridge 不得同时被旧 debug-log 和新 console wrapper 重复采集。
- 迁移期必须明确单一入口和兼容适配层。

### 12.13 崩溃路径

- `process.on('uncaughtException')` 在 Main 初始化早期注册。
- `process.on('unhandledRejection')` 在 Main 初始化早期注册。
- BrowserWindow/webContents 生命周期事件在窗口创建时注册。
- `render-process-gone` 记录 reason、exitCode 和窗口标识。
- `did-fail-load` 记录 errorCode、errorDescription 和经过脱敏的 URL 摘要。
- `unresponsive` 记录时间和窗口状态摘要。
- Renderer 已崩溃时不尝试依赖 Renderer IPC 写日志。
- 崩溃处理不得记录完整工作区快照。

## 13. 安全与隐私边界

### 13.1 数据最小化

- 只保存恢复编辑所需字段。
- 不保存结果集。
- 不保存执行中状态。
- 不保存密码和 API Key。
- 不保存授权头或 token。
- 日志不保存完整 SQL。
- 日志不保存结果行。

### 13.2 进程隔离

- Renderer 不能访问 `better-sqlite3`。
- Renderer 不能访问 electron-log 文件 transport。
- Renderer 不能直接读写日志文件。
- Renderer 不能指定任意清空路径。
- 所有能力通过 `window.sqlStudio` 白名单暴露。
- Main 对所有 IPC 输入做运行时校验。

### 13.3 路径安全

- 工作区快照中的 `filePath` 只是业务数据，不自动执行写入。
- 自动保存不得根据 `filePath` 打开文件写入。
- 日志读取和清空不接受路径参数。
- 手动保存继续走现有明确文件保存路径。
- 外部文件冲突必须由用户决定。

### 13.4 故障处理禁令

- 不准删除 `sql-studio.db` 解决问题。
- 不准删除整个 `userData` 解决问题。
- 不准把数据库损坏恢复等同于重置所有用户数据。
- 不准静默丢弃打开中的脏标签。
- 不准在日志中输出快照正文帮助调试。

## 14. 逐文件改动清单

### 14.1 现有文件

- `src/shared/types.ts`
- 新增工作区快照、日志条目和请求响应共享类型。
- 保证类型不引用 Renderer 或 Main 专属模块。

- `src/shared/ipc-contract.ts`
- 新增 `workspace:load/save/clear`。
- 新增 `logs:append/read/clear`。
- 更新请求和响应映射。
- 保持其为 IPC 唯一事实来源。

- `src/preload/index.ts`
- 原则上依靠 `IPC_CHANNELS` 自动暴露，无需手写每个方法。
- 仅在类型推导或安全白名单测试需要时调整。
- 不暴露 Node API。

- `src/main/services/metadata-store.ts`
- 将数据库 schema version 从 1 迁移到 2。
- 提供受控方式让独立 store 共用同一 Database 实例。
- 推荐提取数据库 owner/context，而非暴露任意 SQL 给上层。
- 接入 foreign_keys 和统一关闭生命周期。

- `src/main/ipc.ts`
- 注入 `WorkspaceRecoveryStore` 和 `PersistentLogService`。
- 注册新增类型化 handler。
- 做运行时输入校验、容量限制和错误映射。
- 不在 handler 内散落 SQL 或文件路径算法。

- `src/main/index.ts`
- 尽早初始化持久日志。
- 初始化共享 SQLite owner、MetadataStore 和 WorkspaceRecoveryStore。
- 注册 BrowserWindow/webContents 崩溃事件。
- 在退出序列加入工作区数据库和日志服务收尾。
- 保持退出超时边界。

- `src/renderer/store/workspace.ts`
- 增加从已验证快照 hydrate 的原子 action。
- hydrate 不恢复 execution、result rows 或 executing。
- 保持关闭脏标签的现有确认上层语义。
- 暴露持久化所需纯状态选择器。

- `src/renderer/App.tsx`
- 在应用启动编排中接入恢复阶段。
- 避免恢复完成前创建并保存错误默认标签。
- 接入结构事件通知和退出 flush。
- 将复杂持久化逻辑委托给独立模块。

- `src/renderer/lib/debug-log.ts`
- 改造成结构化日志门面或兼容适配层。
- 保留北京时间格式化的可复用能力。
- 移除“内存数组即唯一日志源”的假设。
- 防止新旧入口重复记录和递归包装。

- `src/renderer/components/SettingsPanel.tsx`
- 日志列表改为通过 `logs:read` 获取最近 500 条。
- 清空改为调用 `logs:clear`。
- 复制基于 Main 返回并脱敏的数据。
- 保持 debugMode 的产品开关语义。

### 14.2 推荐新增文件

- `src/main/services/workspace-recovery-store.ts`
- 独立封装 DDL、迁移后的 CRUD、事务、revision 和坏行隔离。
- 构造参数接收共享 SQLite 连接。
- 不自行创建第二个数据库连接。

- `src/main/services/persistent-log-service.ts`
- 独立封装 electron-log 初始化、写入、轮转、读取、清空和 flush。
- 只暴露结构化业务方法。
- 内部使用编码前核实的 v5.2.0 API。

- `src/main/services/log-redaction.ts`
- 可选独立纯函数模块。
- 负责对象、文本、Error、URL 和连接摘要脱敏。
- Main 写入前必须调用。

- `src/renderer/lib/workspace-persistence.ts`
- 实现 500ms 防抖、串行队列、latest-wins、revision、重试和 flush。
- 不直接操作 Zustand 内部实现细节，可通过回调读取快照。

- `src/renderer/lib/persistent-log-bridge.ts`
- 实现 Renderer 日志批量、立即发送、背压和重入保护。
- debugMode 关闭时不采集普通 log/info。

- `src/shared/workspace-validation.ts`
- 可选纯校验模块。
- 若 Main 与测试需要共享校验，可集中维护。
- 不引入 Renderer 或 Node 依赖。

### 14.3 建议新增测试文件

- `src/shared/__tests__/ipc-contract.test.ts` 或现有等价位置。
- `src/main/services/__tests__/workspace-recovery-store.test.ts`。
- `src/main/services/__tests__/persistent-log-service.test.ts`。
- `src/main/services/__tests__/log-redaction.test.ts`。
- `src/renderer/lib/__tests__/workspace-persistence.test.ts`。
- `src/renderer/store/__tests__/workspace-recovery.test.ts`。
- 无头 E2E 场景文件按现有测试目录组织。
- Windows Electron 真机验收脚本按现有规范扩展，不另造框架。

### 14.4 最终确认要求

- 上述文件名是推荐落点。
- 执行者必须按当前源码目录和测试约定确认。
- 可以调整测试文件的实际目录。
- 不得改变独立 store、共享连接、类型化 IPC 和 Main 日志所有权的结论。
- 不得借机重构无关功能。

## 15. S0-S6 分阶段实施

### 15.1 S0 基线与备份

- 输入：干净可识别的当前分支、锁文件、本地依赖和测试基线。
- 操作：记录 `git status --short`，保护用户已有改动。
- 操作：记录当前数据库 schema version 和表结构。
- 操作：确认测试命令和 Windows 发布验收流程。
- 操作：确认本地 `electron-log` 实际版本。
- 操作：读取其 README 和类型定义。
- 产物：基线报告、受影响文件清单、API 核实记录。
- 测试：只运行现有基线测试，不做功能改动。
- 决策门：基线失败必须说明是否与本功能无关。
- 停止条件：依赖缺失、版本不符、工作区有冲突改动或无法备份。

### 15.2 S1 Shared 与 IPC 契约

- 输入：S0 基线和本文第 9 章。
- 操作：新增共享类型。
- 操作：新增 channel、请求映射和响应映射。
- 操作：注册临时明确失败或最小 handler，保证契约完整。
- 操作：验证 preload 自动暴露。
- 产物：可编译的类型化 IPC 边界。
- 测试：共享类型、channel 完整性、preload 暴露和错误解包测试。
- 决策门：Renderer 不能通过任何非白名单路径调用 Main。
- 停止条件：出现 `any` 绕过或契约在多处重复定义。

### 15.3 S2 SQLite Store

- 输入：S1 契约和当前 schema version 1。
- 操作：实现数据库 version 2 迁移。
- 操作：新增两个工作区表、索引、外键和约束。
- 操作：实现独立 `WorkspaceRecoveryStore`。
- 操作：注入同一 SQLite 连接。
- 操作：实现 load、save、clear 和 revision 防护。
- 操作：实现逐行校验和坏标签隔离。
- 产物：可独立测试的工作区持久层。
- 测试：DDL、迁移、事务回滚、upsert、删除、旧 revision、坏行和容量。
- 决策门：任意中断后不能出现主表与子表半更新。
- 停止条件：需要第二连接、需要删除旧数据库或迁移不可回滚。

### 15.4 S3 Renderer 自动保存与恢复

- 输入：S2 store 和 S1 IPC。
- 操作：实现 `workspace-persistence.ts`。
- 操作：接入 500ms 防抖和结构事件立即保存。
- 操作：实现串行队列、latest-wins、revision 和三次重试。
- 操作：实现启动 hydrate 屏障。
- 操作：实现退出 flush。
- 操作：保证 execution、results、executing 不进入快照。
- 操作：维持关闭脏标签确认流程。
- 产物：正常重启和异常退出可恢复的编辑工作区。
- 测试：快速输入、多标签、关闭脏标签、保存成功/失败和 hydrate。
- 决策门：自动保存不得触发任何真实文件写入。
- 停止条件：出现静默覆盖 `.sql`、UI 阻塞或恢复导致白屏。

### 15.5 S4 持久日志

- 输入：S0 的 electron-log v5.2.0 API 核实记录。
- 操作：实现 Main `PersistentLogService`。
- 操作：接入 Main 启动和崩溃事件。
- 操作：实现 Renderer 批量 bridge。
- 操作：实现 warn/error 即时发送。
- 操作：实现 read 最近 500 条、clear 和复制数据源。
- 操作：实现轮转、总量、期限和脱敏。
- 操作：处理 console 包装递归风险。
- 产物：跨重启、覆盖 Renderer 崩溃的持久日志。
- 测试：写入、重启读取、轮转、清空、脱敏、debug 开关和崩溃路径。
- 决策门：日志样本中不得出现任何测试凭据或完整 SQL。
- 停止条件：依赖未核实 API、路径可越权或日志递归爆量。

### 15.6 S5 异常、迁移与容量加固

- 输入：S2-S4 的可运行实现。
- 操作：注入损坏行、未知版本和迁移失败。
- 操作：模拟磁盘满、权限错误和 SQLite busy。
- 操作：模拟外部文件修改和删除。
- 操作：模拟连接失效。
- 操作：验证日志目录总量清理。
- 操作：验证恢复降级不白屏。
- 产物：异常矩阵报告和已修复缺陷清单。
- 测试：故障注入、容量边界和迁移兼容测试。
- 决策门：所有数据损坏场景都有非破坏性降级路径。
- 停止条件：任何方案依赖删除 `sql-studio.db` 或整个 `userData`。

### 15.7 S6 全量与 Windows 发布验收

- 输入：S5 通过的候选版本。
- 操作：运行 Shared、Main、Renderer 和无头 E2E 全量测试。
- 操作：生成 Windows Electron 发布包。
- 操作：在 Windows 真机验证正常退出、叉窗、kill、崩溃和重启。
- 操作：验证真实用户路径、非 ASCII 路径和长路径。
- 操作：验证发布包日志位置、轮转和清空。
- 操作：验证旧数据库迁移后连接和历史仍完整。
- 产物：Windows 发布验收报告、日志样本和迁移证据。
- 测试：执行第 16 章全部矩阵。
- 决策门：所有发布阻断项关闭。
- 停止条件：数据丢失、静默文件覆盖、白屏、凭据泄漏或不可回退迁移。

### 15.8 阶段报告规则

- 每阶段必须报告实际修改文件。
- 每阶段必须报告执行命令和结果摘要。
- 每阶段必须报告新增和修改测试。
- 每阶段必须报告失败项和残余风险。
- 每阶段必须等待决策门通过再进入下一阶段。
- 失败时停止扩大修改范围。

## 16. 测试矩阵

### 16.1 Shared 契约测试

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| SH-01 | 新增 channel 完整 | 请求和响应映射均存在 |
| SH-02 | preload 自动暴露 | 所有新 channel 可调用 |
| SH-03 | 非法日志级别 | Main 拒绝 |
| SH-04 | limit 大于 500 | 被夹到 500 或拒绝 |
| SH-05 | 超大日志批次 | 被限制且返回 dropped |
| SH-06 | 非法 workspaceId | Main 拒绝 |
| SH-07 | revision 为负 | Main 拒绝 |

### 16.2 Main Store 测试

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| MS-01 | v1 数据库迁移 | 新表创建，旧数据不变 |
| MS-02 | 首次保存 | 主表和标签一次提交 |
| MS-03 | 更新保存 | 标签完整替换且顺序正确 |
| MS-04 | 旧 revision | 不覆盖新状态 |
| MS-05 | 中途异常 | 整体事务回滚 |
| MS-06 | clear | 仅删除工作区记录 |
| MS-07 | 单标签坏行 | 隔离坏行，恢复其余 |
| MS-08 | 主行损坏 | 返回空工作区和警告 |
| MS-09 | 外键开启 | 孤立标签不可写入 |
| MS-10 | 容量超限 | 明确失败，不截断 SQL |
| MS-11 | 数据库 busy | 可重试错误 |
| MS-12 | 磁盘满 | 非破坏性失败 |

### 16.3 Renderer 调度测试

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| RD-01 | 单次输入 | 500ms 后保存 |
| RD-02 | 连续快速输入 | 只保存必要最新快照 |
| RD-03 | 保存中继续输入 | 完成后保存最新 generation |
| RD-04 | 标签切换 | 立即排队保存 |
| RD-05 | 新建标签 | 立即排队保存 |
| RD-06 | 关闭标签 | 确认后立即保存 |
| RD-07 | 连接切换 | 立即排队保存 |
| RD-08 | IPC 一次失败 | 自动重试 |
| RD-09 | 连续三次失败 | 非阻塞告警 |
| RD-10 | flush 成功 | deadline 前完成 |
| RD-11 | flush 超时 | 不永久阻塞关闭 |
| RD-12 | hydrate 期间 | 不写错误默认快照 |

### 16.4 工作区产品测试

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| WS-01 | 首次启动无数据 | 空工作区正常启动 |
| WS-02 | 正常重启 | 标签、顺序、活动项恢复 |
| WS-03 | 窗口叉掉 | 最后快照恢复 |
| WS-04 | 进程 kill | 最后提交快照恢复 |
| WS-05 | Renderer crash | Main 日志存在，工作区可恢复 |
| WS-06 | 白屏后重启 | 不因坏快照再次白屏 |
| WS-07 | 多标签 | 顺序和 activeTabId 准确 |
| WS-08 | 未命名标签 | 内容和脏状态准确 |
| WS-09 | 空白草稿 | 合法恢复 |
| WS-10 | 打开文件未改 | 恢复后非脏 |
| WS-11 | 已保存文件再修改 | 恢复后为脏 |
| WS-12 | 恢复后手动保存 | 写真实文件并清脏 |
| WS-13 | 自动保存期间 | 原文件 mtime 不变 |
| WS-14 | 关闭脏标签取消 | 标签和记录保留 |
| WS-15 | 关闭脏标签并放弃 | 标签记录删除 |
| WS-16 | 关闭脏标签保存失败 | 不关闭、不删记录 |
| WS-17 | 外部文件修改 | 提示冲突，不覆盖 |
| WS-18 | 外部文件删除 | 恢复草稿并标脏 |
| WS-19 | 当前连接失效 | 文本恢复，连接回退 |
| WS-20 | execution 存在 | 重启后不恢复 |
| WS-21 | results 存在 | 重启后不恢复 rows |
| WS-22 | executing 存在 | 重启后不恢复执行态 |

### 16.5 持久日志测试

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| LG-01 | Main 启动 | 启动日志落盘 |
| LG-02 | Renderer info + debug off | 不采集普通 info |
| LG-03 | Renderer info + debug on | 批量落盘 |
| LG-04 | Renderer warn | 立即发送 |
| LG-05 | Renderer error | 立即发送并 flush |
| LG-06 | 应用重启 | 旧日志仍可见 |
| LG-07 | 最近 500 条 | 数量和顺序正确 |
| LG-08 | 北京时间展示 | 与 UTC 转换正确 |
| LG-09 | 复制 | 最多 500 条且已脱敏 |
| LG-10 | 清空 | Main 清受控日志 |
| LG-11 | 路径注入 | 无法越权 |
| LG-12 | 单文件超限 | 发生轮转 |
| LG-13 | 归档超数 | 删除最旧归档 |
| LG-14 | 超过 14 天 | 清理过期归档 |
| LG-15 | 总量超 60 MiB | 降至上限内 |
| LG-16 | password 字段 | 值被替换 |
| LG-17 | API Key 字段 | 值被替换 |
| LG-18 | Authorization | 值被替换 |
| LG-19 | Bearer token | 值被替换 |
| LG-20 | 连接串 | 不出现完整原文 |
| LG-21 | SQL 日志 | 只有长度/hash/queryId/状态 |
| LG-22 | 循环对象 | 安全序列化不崩溃 |
| LG-23 | console 包装 | 不递归重复 |
| LG-24 | render-process-gone | Main 独立落盘 |
| LG-25 | unresponsive | Main 独立落盘 |
| LG-26 | did-fail-load | Main 独立落盘 |
| LG-27 | uncaughtException | 尽力落盘且不泄密 |
| LG-28 | unhandledRejection | 尽力落盘且不泄密 |

### 16.6 无头 E2E

- 启动应用并创建多个标签。
- 输入 SQL 后等待防抖完成。
- 重启应用并验证 DOM 中标签和内容。
- 模拟快速输入并检查最终内容。
- 模拟 IPC 保存失败后恢复。
- 模拟损坏工作区响应并验证空工作区降级。
- 验证设置面板读取最近日志。
- 验证清空按钮调用 Main channel。
- 验证 debugMode 开关影响普通 Renderer 日志采集。
- 验证自动保存没有调用 `script:save`。

### 16.7 Windows Electron 真机

- 使用发布包而不是仅开发模式。
- 使用含中文和空格的 Windows 用户目录。
- 验证正常退出和重新启动。
- 验证点击窗口关闭按钮。
- 使用任务管理器结束 Renderer 进程。
- 使用任务管理器结束整个应用。
- 触发测试用 Renderer crash。
- 验证白屏后 Main 日志。
- 验证日志路径位于正确 userData。
- 验证日志轮转和清空。
- 验证打开文件、修改、重启和手动保存。
- 验证外部编辑器修改同一文件后的冲突提示。
- 验证连接已删除时工作区仍恢复。
- 验证升级安装不删除旧数据库。
- 验证卸载/重装行为按发布规范记录，不做隐式承诺。

## 17. 发布阻断条件

- 自动保存会写入或覆盖真实 `.sql` 文件。
- 用户未明确放弃却丢失脏标签恢复记录。
- 查询结果集被写入工作区数据库。
- `executing` 或执行状态被恢复。
- 密码、API Key、Authorization、Bearer token 或完整连接串出现在日志。
- 完整 SQL 出现在持久日志。
- Renderer 绕过 preload 直接访问 Node、SQLite 或文件系统。
- 旧 revision 能覆盖新 revision。
- 工作区事务可产生半更新状态。
- 坏记录会导致应用白屏或启动循环崩溃。
- 迁移失败时删除或重建整个数据库。
- 解决问题依赖删除 `sql-studio.db` 或整个 `userData`。
- 日志清空存在路径越权。
- 日志没有轮转、总量或期限限制。
- Renderer 崩溃后 Main 没有持久崩溃日志。
- Windows 发布包未完成真机验收。
- 任何 S0-S6 决策门未通过。

## 18. 风险清单与缓解措施

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 高频输入导致 IPC 风暴 | 性能下降 | 500ms 防抖和 latest-wins |
| 异步乱序覆盖 | 草稿回退 | 串行队列加 Main revision 条件 |
| 退出时间不足 | 最新输入丢失 | 持续保存加短时 flush |
| SQLite 事务失败 | 快照不一致 | 单事务替换和回滚 |
| 标签内容过大 | 数据库膨胀 | 单标签和总工作区上限 |
| 空间不足 | 保存和日志失败 | 分类错误、告警和总量清理 |
| 坏标签阻断恢复 | 白屏 | 逐行校验和隔离 |
| 未知版本被覆盖 | 降级数据损坏 | 未知版本只读隔离 |
| 外部文件冲突 | 覆盖用户内容 | 明确冲突 UI，不自动写文件 |
| 连接被删除 | 恢复失败 | 连接回退，不影响文本 |
| 日志泄漏凭据 | 安全事件 | Renderer/Main 双层脱敏 |
| SQL 含敏感值 | 数据泄漏 | 仅长度/hash/queryId/状态 |
| 日志路径越权 | 任意文件删除 | Main 固定受控路径 |
| console 递归 | 日志爆量或崩溃 | 原始引用、重入 guard、去重 |
| electron-log API 版本差异 | 运行错误 | S0 读取本地 README 和类型 |
| Main 崩溃来不及 flush | 诊断缺失 | 即时写 error、系统崩溃设施补充 |
| App.tsx 继续膨胀 | 可维护性下降 | 持久化协调器独立模块 |
| 第二 SQLite 连接 | 锁和迁移复杂 | 独立 store 共用同一连接 |

## 19. 备份、回退、数据兼容与迁移

### 19.1 实施前备份

- S0 记录 Git 基线和用户已有改动。
- 对测试使用临时 userData，不直接使用真实用户目录。
- 发布迁移前制定数据库文件备份策略。
- 备份应包含 `sql-studio.db`、`-wal` 和 `-shm` 的一致性考虑。
- 不允许在应用运行中随意复制不一致文件集合。
- 优先使用 SQLite 官方一致性备份能力或停机备份流程。

### 19.2 数据库迁移兼容

- v1 → v2 仅新增工作区表和索引。
- 不修改现有连接、历史和设置数据语义。
- 迁移在单事务内完成。
- 迁移失败保持 v1 可识别状态。
- 成功后记录 version 2。
- 重复启动不得重复破坏性迁移。

### 19.3 应用回退

- 旧版本应用应忽略未知工作区表。
- 回退前确认旧版本如何处理较高数据库 schema version。
- 若旧版本拒绝较高版本，需要在发布前提供兼容策略。
- 兼容策略不得删除工作区数据或其他现有表。
- 可考虑让旧版本忽略新增表，但必须用实际旧包验证。
- 不允许用“删库重建”作为回退步骤。

### 19.4 工作区 schema 迁移

- 快照包含独立 `schemaVersion`。
- 每次加载先读版本再解码字段。
- 旧版本通过纯函数逐级迁移到当前版本。
- 迁移后以新 revision 保存。
- 未知未来版本不覆盖。
- 迁移测试保留固定 fixture。

### 19.5 日志兼容

- 日志文件不作为业务数据兼容承诺。
- 新版本必须能容忍旧格式行。
- 读取最近 500 条时跳过不可解析行并计数。
- 清空只操作服务管理的日志文件。
- 回退不依赖日志文件存在。

### 19.6 回退触发条件

- 发现草稿丢失。
- 发现真实文件被静默覆盖。
- 发现凭据或完整 SQL 泄漏到日志。
- 发现数据库迁移破坏既有数据。
- 发现持续白屏或无法启动。
- 发现日志无限增长。

## 20. 执行者禁止事项

- 禁止改变已定稿技术方向。
- 禁止让 Renderer 直接访问 SQLite。
- 禁止让 Renderer 直接访问文件系统。
- 禁止绕过 preload 类型化 IPC。
- 禁止把工作区仅塞入通用 settings 字符串键值。
- 禁止为工作区新建第二个 SQLite 数据库文件。
- 禁止为独立 store 新开不受控 SQLite 连接。
- 禁止把日志写入 SQLite。
- 禁止自动保存调用真实文件保存。
- 禁止静默覆盖原 `.sql`。
- 禁止关闭确认前删除脏标签恢复记录。
- 禁止持久化 execution、result rows 或 executing。
- 禁止持久化密码、API Key 或 token。
- 禁止记录完整 SQL 到日志。
- 禁止通过删除 `sql-studio.db` 修复问题。
- 禁止删除整个 `userData`。
- 禁止臆造 electron-log API。
- 禁止未读本地 v5.2.0 README 和类型定义就编码日志服务。
- 禁止通过接受任意路径实现日志读取或清空。
- 禁止扩大到无关重构、样式改版或新产品功能。
- 禁止跳过阶段测试直接进入发布。
- 禁止在失败后继续扩大修改范围。

## 21. 可直接交付给执行者的最终任务指令模板

```text
任务名称：实现 SQL Studio 自动保存、工作区恢复与调试日志持久化。

唯一实施依据：
1. 本实施方案。
2. 当前仓库源码。
3. 本地 node_modules/electron-log README 与类型定义。

固定技术方向：
- 工作区写入现有 userData/sql-studio.db。
- Renderer → preload 类型化 IPC → Main → SQLite。
- 新增独立 WorkspaceRecoveryStore，共用 MetadataStore 的同一 SQLite 连接和事务边界。
- 自动保存只保存恢复草稿，绝不覆盖真实 .sql 文件。
- electron-log 文件由 Main 管理，日志不进入 SQLite。

执行方式：
- 严格按 S0、S1、S2、S3、S4、S5、S6 顺序实施。
- 每阶段只做该阶段范围内的最小修改。
- 每阶段完成后提交阶段报告和测试证据。
- 未通过决策门不得进入下一阶段。
- 失败时立即停止，不得自行扩大范围。

强制要求：
- SQL 编辑 500ms 防抖。
- 结构事件立即排队。
- 串行写队列、latest-wins、revision、重试和退出 flush。
- 不持久化 execution、result rows、executing、密码或 API Key。
- 关闭脏标签继续现有确认；明确关闭后才删除恢复记录。
- Main 捕获 render-process-gone、unresponsive、did-fail-load、uncaughtException、unhandledRejection。
- Renderer warn/error 即时发送；debugMode 开启时批量发送 log/info。
- 日志最近 500 条、清空、复制、北京时间、轮转、总量、期限和脱敏全部落地。
- SQL 日志只允许长度、hash、queryId、状态、duration 等摘要。
- 恢复失败必须启动空工作区并记录诊断，不能白屏。

electron-log 核实：
- 编码前读取本地锁文件、README 和 .d.ts。
- 在 S0 报告中列出实际版本、导入方式、file transport、路径、轮转和 flush/clear 能力。
- 不得凭记忆使用 API。

禁止：
- 不得删除 sql-studio.db。
- 不得删除整个 userData。
- 不得自动写真实 SQL 文件。
- 不得接受 Renderer 提供的日志文件路径。
- 不得做无关重构。

每阶段报告格式：
- 阶段：
- 实际修改文件：
- 关键实现：
- 执行测试：
- 测试结果：
- 数据与安全检查：
- 未完成项：
- 风险：
- 决策门结论：通过/不通过。
- 下一步：
```

## 22. 最终验收报告模板

```text
# SQL Studio 自动保存与持久日志最终验收报告

## 1. 基本信息
- 版本/提交：
- 构建时间：
- 验收环境：
- Windows 版本：
- Electron 版本：
- electron-log 实际版本：

## 2. 实际变更
- Shared/IPC：
- SQLite/迁移：
- Renderer 自动保存：
- 启动恢复：
- Main 持久日志：
- 设置面板日志能力：

## 3. 核心不变量验证
- 自动保存未写真实 .sql：通过/不通过，证据：
- 脏标签确认后才删除：通过/不通过，证据：
- 未持久化 execution/results/executing：通过/不通过，证据：
- 未持久化密码/API Key：通过/不通过，证据：
- 日志无完整 SQL 和凭据：通过/不通过，证据：
- 坏记录不导致白屏：通过/不通过，证据：
- 未删除 sql-studio.db/userData：通过/不通过，证据：

## 4. 测试结果
- Shared：
- Main：
- Renderer：
- 无头 E2E：
- Windows Electron 真机：
- 失败和跳过项：

## 5. 场景验收
- 正常重启：
- 窗口叉掉：
- kill/crash/白屏：
- 连续快速输入：
- 多标签和未命名标签：
- 外部文件变化：
- 连接失效：
- 日志重启可见：
- 轮转、清空和脱敏：
- Renderer 崩溃日志：

## 6. 数据迁移与回退
- v1 → v2 迁移：
- 旧数据完整性：
- 回退演练：
- 备份位置与恢复验证：

## 7. 残余风险
- 风险：
- 影响：
- 缓解：
- 责任人：

## 8. 发布结论
- 发布阻断项：0 / 非 0。
- 建议：发布/不发布。
- 验收人：
- 日期：
```

## 23. Definition of Done 检查表

### 23.1 架构与边界

- [ ] 工作区使用现有 `userData/sql-studio.db`。
- [ ] Renderer 只通过 preload 类型化 IPC 访问持久层。
- [ ] `WorkspaceRecoveryStore` 为独立 store。
- [ ] 独立 store 与 MetadataStore 共用同一 SQLite 连接。
- [ ] 日志使用 Main 管理的 electron-log 文件。
- [ ] 日志未写入 SQLite。

### 23.2 工作区数据

- [ ] 保存 tabs。
- [ ] 保存 tab 顺序。
- [ ] 保存 activeTabId。
- [ ] 保存 currentConnectionId。
- [ ] 保存 schemaVersion。
- [ ] 保存 revision。
- [ ] 保存 createdAt 和 updatedAt。
- [ ] 保存 isDirty、filePath 和 sqlContent。
- [ ] 未保存 execution。
- [ ] 未保存 result rows。
- [ ] 未保存 executing。
- [ ] 未保存密码、API Key 或 token。

### 23.3 自动保存

- [ ] SQL 编辑采用 500ms 防抖。
- [ ] 结构事件立即排队。
- [ ] 队列串行执行。
- [ ] latest-wins 生效。
- [ ] Main revision 防旧覆盖生效。
- [ ] 自动重试最多 3 次。
- [ ] 退出 flush 有截止时间。
- [ ] 保存失败不阻塞 UI。
- [ ] 容量超限不静默截断 SQL。
- [ ] 自动保存不调用 `script:save`。
- [ ] 自动保存不改变真实文件 mtime。

### 23.4 恢复规则

- [ ] 首次启动无数据可正常启动。
- [ ] 正常重启恢复完整工作区。
- [ ] 窗口叉掉后可恢复。
- [ ] kill/crash 后恢复最后提交快照。
- [ ] 多标签顺序准确。
- [ ] 未命名标签恢复准确。
- [ ] 已保存文件的未保存修改恢复为脏。
- [ ] 主动关闭脏标签前维持确认。
- [ ] 用户明确关闭后才删除恢复记录。
- [ ] 外部文件变化不静默覆盖。
- [ ] 当前连接失效不阻止文本恢复。
- [ ] 损坏行被隔离。
- [ ] 恢复失败不会白屏。
- [ ] 恢复失败时启动空工作区并保留日志。

### 23.5 SQLite

- [ ] 明确执行 v1 → v2 迁移。
- [ ] `workspace_snapshots` 创建成功。
- [ ] `workspace_tabs` 创建成功。
- [ ] 外键开启。
- [ ] 约束和索引存在。
- [ ] 保存使用单事务。
- [ ] 清空只删除工作区数据。
- [ ] 旧 revision 不覆盖新 revision。
- [ ] 迁移失败不删除数据库。
- [ ] 未通过删除 `sql-studio.db` 处理任何问题。
- [ ] 未通过删除整个 `userData` 处理任何问题。

### 23.6 IPC 与 preload

- [ ] `workspace:load` 契约完整。
- [ ] `workspace:save` 契约完整。
- [ ] `workspace:clear` 契约完整。
- [ ] `logs:append` 契约完整。
- [ ] `logs:read` 契约完整。
- [ ] `logs:clear` 契约完整。
- [ ] Main handler 全部注册。
- [ ] preload 自动暴露全部新增 channel。
- [ ] IPC 输入有运行时校验。
- [ ] 不存在 Renderer `ipcRenderer` 直用。

### 23.7 持久日志

- [ ] 已读取本地 electron-log README 和类型定义。
- [ ] 已确认实际 v5.2.0 兼容 API。
- [ ] Main 从启动早期采集日志。
- [ ] warn/error 即时发送。
- [ ] debugMode 开启时批量采集 log/info。
- [ ] debugMode 关闭不影响 Main 崩溃日志。
- [ ] `render-process-gone` 已采集。
- [ ] `unresponsive` 已采集。
- [ ] `did-fail-load` 已采集。
- [ ] `uncaughtException` 已采集。
- [ ] `unhandledRejection` 已采集。
- [ ] Renderer 崩溃后 Main 仍能写日志。
- [ ] 最近 500 条读取可用。
- [ ] 清空通过 Main 完成。
- [ ] 复制使用北京时间。
- [ ] 日志轮转生效。
- [ ] 日志总量上限生效。
- [ ] 14 天保留期限生效。
- [ ] 清空不存在路径越权。
- [ ] console 包装不存在递归。

### 23.8 脱敏与隐私

- [ ] password 脱敏。
- [ ] API Key 脱敏。
- [ ] Authorization 脱敏。
- [ ] Bearer token 脱敏。
- [ ] 一般 token 字段脱敏。
- [ ] 完整连接串不落日志。
- [ ] 完整 SQL 不落日志。
- [ ] SQL 仅记录长度、hash、queryId、状态等摘要。
- [ ] 查询结果行不落日志。
- [ ] Error message 和 stack 经过脱敏。
- [ ] Renderer 和 Main 双层脱敏已测试。

### 23.9 测试与发布

- [ ] Shared 测试通过。
- [ ] Main 测试通过。
- [ ] Renderer 测试通过。
- [ ] 无头 E2E 通过。
- [ ] Windows Electron 真机通过。
- [ ] 正常退出场景通过。
- [ ] 窗口叉掉场景通过。
- [ ] kill/crash/白屏场景通过。
- [ ] 快速连续输入场景通过。
- [ ] 多标签场景通过。
- [ ] 关闭脏标签场景通过。
- [ ] 恢复后手动保存场景通过。
- [ ] 损坏数据场景通过。
- [ ] 外部文件变化场景通过。
- [ ] 连接失效场景通过。
- [ ] 日志重启可见场景通过。
- [ ] 日志轮转、清空和脱敏场景通过。
- [ ] 所有发布阻断条件已排除。

### 23.10 最终签署

- [ ] S0-S6 阶段报告齐全。
- [ ] 实际修改范围与批准范围一致。
- [ ] 无无关重构。
- [ ] 数据迁移证据齐全。
- [ ] 回退路径已验证。
- [ ] 最终验收报告已填写。
- [ ] 发布负责人确认。
- [ ] 测试负责人确认。
- [ ] 技术负责人确认。
