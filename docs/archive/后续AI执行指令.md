# SQL Studio 后续 AI 执行指令

> 用途：将本文档直接交给负责修改项目的 AI，要求其按阶段执行，不跨阶段扩大范围。
> 项目路径：`/vol1/1000/docker/Services/deepseek-harness/DSH_projects/sql_plus/SQL_project`
> 适用对象：能够读取源码、修改文件、运行命令并回传证据的开发 AI。
> 编写日期：2026-08-30
>
> **2026-09-01 执行记录（本轮运行时正确性修复，7 阶段）：** 已在同一会话按「消息中的阶段 1-7」执行完毕——
> FIM 补全协议、API Key 隐藏、调试日志北京时间、结果区横向滚动、对象浏览器/预览/表字段导航滚动稳定性。
> `npm run typecheck` ✅ / `npm test` ✅（32 文件 / 398 用例）/ `npm run build` ✅ / 无头 E2E 三脚本 ✅。
> 真实 DeepSeek API 调用与 Windows Electron GUI 验收在 NAS 无头环境无法执行，标记为**「已实现未验证」**，
> 未写为「已完成」。本文件下文 S0-S7 为本轮之前一轮（2026-08-30）的指令，仍作为历史基准保留。

## 0. 总指令

你负责对 SQL Studio 做下一轮运行时正确性、安全边界、可维护性和真实环境验证升级。

开始前必须读取：

1. `docs/升级优化实施计划.md`
2. `docs/测试与发布验收规范.md`
3. `docs/开发文档.md`
4. `docs/架构文档.md`
5. 与当前阶段直接相关的源码和测试文件

执行规则：

- 先检查 `git status` 和当前 diff，不覆盖已有改动。
- 每次只执行一个阶段，完成验证并汇报后才能进入下一阶段。
- 先小范围修改和验证，再进行全量验证。
- 不把规划项写成已完成，不用历史测试数字代替本次命令结果。
- 不修改用户数据目录，不用删除数据或重装依赖掩盖问题。
- 保持 Main、Preload、Renderer 分层；Renderer 不访问 Node、数据库或明文密码。
- 未经明确批准，不改变 IPC channel 名称和共享数据契约。
- 发现范围外问题时记录，不顺手扩大改动。

每个阶段结束必须回传：

- 阶段编号和目标。
- 修改文件清单。
- 行为变化和兼容性影响。
- 执行过的命令、退出码和实际摘要。
- 新增或修改的测试。
- 已知限制和回退方式。
- 是否满足决策门。
- 是否建议进入下一阶段。

## 1. S0：基线确认

目标：证明当前工作区、源码、文档和验证基线一致。

执行：

1. 检查 `git status --short`、当前提交和已有 diff。
2. 检查 Node、npm、Electron 和 better-sqlite3 版本。
3. 执行 `npm run typecheck`。
4. 执行 `npm test`，记录实际测试文件数、用例数和失败信息。
5. 执行 `npm run build`。
6. 检查 `dist/main/main.cjs`、`dist/main/preload.cjs` 和 Renderer 产物。
7. 检查 `.bak` 文件是否被 Git 跟踪、是否可能进入产物。
8. 对照文档列出的遗留问题，确认哪些仍真实存在。

完成标准：三条基础命令全部通过，或明确记录阻断原因；没有覆盖既有修改；形成基线报告。

停止条件：任何基础命令失败，先报告失败根因，不进入 S1。

## 2. S1：收藏定位统一

目标：收藏保存、读取、删除和重命名使用一致且安全的定位规则。

先读：

- `src/main/services/favorites-store.ts`
- `tests/main/favorites-store.test.ts`
- `src/main/ipc.ts` 中 favorites handler

执行：

1. 明确逻辑名称、文件名和文件头 metadata 的优先级。
2. 统一安全化、反向定位和重名规则。
3. 覆盖路径分隔符、系统保留字符、空名、超长名称、相似名称和重复名称。
4. 确保重命名/删除失败时不破坏原文件。
5. 保持旧格式可读取，不能未经设计批量迁移。
6. 先补测试，再实现最小修改。

验证：运行 favorites 相关测试、`npm test`、`npm run typecheck`、`npm run build`。

完成标准：保存后能准确打开；重命名后能准确读取和删除；相似名称不会误匹配；非法名称不能越出收藏目录。

## 3. S2：SQL 导出与标识符安全

目标：SQL INSERT 和 CSV 导出在边界输入下正确、安全、可验证。

先读：

- `src/main/services/sql-exporter.ts`
- `src/main/services/csv-exporter.ts`
- `tests/main/sql-exporter.test.ts`
- `tests/main/csv-exporter.test.ts`

执行：

1. 统一表名和列名的标识符转义。
2. 明确 `database.table` 输入规则，禁止把 SQL 片段当标识符拼接。
3. 补齐 NULL、数字、布尔、二进制、引号、反斜杠、换行、回车和 NUL 测试。
4. 校验 batchSize，拒绝 0、负数和不合法值。
5. 保持 CSV UTF-8 BOM、RFC 4180、公式注入防护和 backpressure 行为。
6. 使用测试构造包含特殊标识符和值的输出。

验证：相关测试、全量测试、typecheck、build；在可用的真实 MySQL/MariaDB 中执行至少一份生成 INSERT。

完成标准：生成 SQL 可解析并能执行；恶意值不会改变 SQL 结构；大批量导出不会因 batchSize 进入死循环。

停止条件：真实数据库验证不可用时，标记“已实现未验证”，不能标成完全通过。

## 4. S3：SQL 写操作识别与安全策略

目标：Renderer 提示和 Main 安全策略一致；无法确定时不得放行。

先读：

- `src/renderer/lib/sql-utils.ts`
- `src/main/services/query-service.ts`
- `src/main/ipc.ts`
- `src/shared/types.ts`
- 相关测试

执行：

1. 明确 INSERT、UPDATE、DELETE、REPLACE、ALTER、DROP、TRUNCATE 的策略。
2. 明确 CTE 写操作、CALL、多语句读写混合的策略。
3. 覆盖注释、字符串、括号、大小写、前置空白和嵌套查询。
4. 评估是否需要无 Electron 依赖的共享分类模块。
5. 不用简单正则声称覆盖完整 SQL 方言。
6. Main 不能只信任 Renderer 传入的“是否写操作”结果。
7. 不确定语句按高风险处理，给出可读错误或确认路径。

验证：正例、反例和模糊样例测试；Renderer、Main、IPC 相关测试；全量 typecheck/test/build。

完成标准：纯读不误报，高风险不放行，混合语句策略明确，Renderer 和 Main 行为一致。

## 5. S4：服务依赖注入与 IPC 组织

目标：服务实例、生命周期和 IPC handler 注册方式清晰稳定。

先读：

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/services/*`
- `tests/main/ipc.test.ts`
- `tests/shared/ipc-contract.test.ts`

执行：

1. 列出所有服务实例的创建点和使用点。
2. 消除 IPC handler 内不必要的重复实例化。
3. 明确服务初始化、使用和关闭顺序。
4. 保持 IPC channel 名称、请求/响应类型和 preload 行为不变。
5. 先做最小依赖注入调整，不同时重写业务逻辑。

验证：Main、IPC、Shared 测试；typecheck；build；检查重复 handler 注册和退出关闭路径。

完成标准：每个 handler 使用预期实例；不会重复注册；查询取消和连接关闭行为不回归。

停止条件：如果必须改变 IPC 契约，暂停并先提交兼容性方案。

## 6. S5：查询耗时、取消和资源释放

目标：查询结果耗时、取消、历史和连接释放语义明确。

先读：

- `src/main/services/query-service.ts`
- `src/main/services/connection-manager.ts`
- `src/main/ipc.ts`
- 相关测试

执行：

1. 先记录当前临时连接和连接池的真实使用路径。
2. 验证单语句、多语句、并发、失败、截断和取消。
3. 明确 `QueryResultSet.elapsedMs` 与总耗时的语义。
4. 确认 abort 后连接释放且不会错误写入历史。
5. 单独评估是否值得把普通查询改为连接池，不要默认改动。

验证：query/connection/IPC 测试；typecheck/test/build；真实 MySQL 至少一次取消冒烟。

完成标准：取消行为可证实，连接释放可证实，耗时字段语义和测试一致。

停止条件：连接池改造的兼容性、取消或多语句策略无法证明时，保留现状并记录，不扩大改造。

## 7. S6：系统文件对话框与路径边界

目标：打开、保存、另存为和导出使用清晰的系统文件流程，取消和覆盖行为正确。

先读：

- `src/main/services/script-store.ts`
- `src/main/ipc.ts`
- `src/preload/index.ts`
- Renderer 中打开、保存、另存为和导出流程
- `docs/e2e-checklist.md`

执行：

1. 识别仍使用 `window.prompt` 的入口。
2. 设计并实现系统对话框调用边界，业务服务不直接持有 UI 状态。
3. 处理取消、覆盖确认、默认目录、最近目录和权限失败。
4. 覆盖 Windows 盘符、UNC、非 ASCII 文件名和不存在路径。
5. 检查 `shell:showItemInFolder` 的路径来源和越权风险。

验证：必须在 Windows 图形环境执行真实 Electron GUI；补充取消、覆盖、无权限和路径异常证据。

完成标准：用户可以完成完整文件旅程，取消不会创建或覆盖文件，错误有可读反馈。

停止条件：只有 NAS 无头验证时，标记“已实现未验证”，不能替代 Windows GUI 结论。

## 8. S7：最终真实环境与发布验收

目标：证明项目在目标环境可运行并具备发布条件。

执行完整旅程：

1. 启动 Electron，确认 Main、Preload、Renderer 无错误。
2. 连接测试 MySQL/MariaDB。
3. 浏览 Schema，测试表/字段双击行为。
4. 执行单语句、多语句、读写混合、CTE、CALL 和取消。
5. 验证结果排序、筛选、复制、截断和导出。
6. 验证历史、收藏、打开、保存、另存为。
7. 验证错误、重试、取消、覆盖确认和权限失败。
8. 验证 Windows 打包产物启动。
9. 检查 better-sqlite3 ABI。
10. 检查生产构建不依赖 Monaco CDN。
11. 检查日志没有密码、API Key 和完整敏感 SQL。

最终通过标准：

- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 无头 E2E 通过。
- Windows Electron GUI 冒烟通过。
- MySQL/MariaDB 查询和取消冒烟通过。
- 收藏、文件路径、导出回归通过。
- 打包产物启动通过。
- 没有未解释的 P0/P1 风险。

## 9. 统一阶段回报模板

每完成一个阶段，严格按以下格式回报：

```text
阶段：Sx
目标：...
结论：通过 / 不通过 / 已实现未验证
修改文件：...
新增或修改测试：...
验证命令：...
实际结果：...
真实环境证据：...
已知限制：...
回退方式：...
决策门：允许 / 不允许进入下一阶段
```

## 10. 禁止事项

- 不要一次性修改 S1-S7 全部内容。
- 不要跳过基线验证。
- 不要只报告“代码已改好”，必须提供命令和结果。
- 不要只检查文件存在就宣布重构完成。
- 不要把无头截图当成 Windows GUI 完整替代。
- 不要为通过测试删除或修改原有有效测试。
- 不要改变密码存储边界。
- 不要把完整敏感 SQL、密码或 API Key 写入日志。
- 不要在未说明的情况下修改 Main、Preload、Shared 或 IPC 契约。
