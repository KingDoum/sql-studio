# 项目长期记忆 · SQL Studio

## 用户与项目约定

- **生产库是真实业务库，必须只读对待**：用户提供了正式环境凭据（腾讯云 CynosDB MySQL 8.0.30，业务库 `ads_yewu` / `ods_yewu` / `finedb`）。任何针对该库的操作**只允许 SELECT / SHOW / DESCRIBE / EXPLAIN**；凭据不写入仓库、不写入记忆文件。要用它做测试时，走一次性临时探针（跑完即删），并加 `readOnly()` 断言守卫。
- **本地 Windows 迭代流程**：`npm run package:dir` 产出 `release/win-unpacked/`（免安装，不需要开发者模式/管理员）。正式 NSIS 包才需要符号链接权限。
- **原生模块 ABI 双态**：跑过 `electron-builder` 后 `better-sqlite3` 变 Electron ABI，`npm test` 前需 `npm rebuild better-sqlite3`；反之 `npm run dev` 需 Electron ABI。
- **网络**：npm registry 用 npmmirror 直连最快；GitHub 二进制走系统代理 `127.0.0.1:7897`。
- **git 身份**：`kingdou <1065576641@qq.com>`（全局）；项目历史早期提交作者为 `KingDoum <kingdoums@icloud.com>`。

## 技术约定（改代码时必须遵守）

- `theme` 不是合法 Monaco editor option，设置主题必须用 `monaco.editor.setTheme()`；`onMount` 闭包里的 props 是首次渲染值，需要 ref 镜像。
- Monaco 的 `disposeInlineCompletions` 是**结果级回收**回调（reason: lostRace 等），不是 provider 销毁 —— 必须是 no-op，置 `cancelled` 会让 AI 补全永久失效。
- Excel 导出的列 key 必须用**列下标**（结果集可能含 JOIN 同名列，用列名会互相覆盖）。
- `Security.decrypt` 按密文前缀分流：`hex:`（safeStorage 二进制）、`b64:`（必须走 base64 解码，不能交给当前加密器）、无前缀明文原样返回。
- 连接列表/摘要路径**不解密**密码（`rowToSummary`），单条坏密文不得拖垮连接列表。
- Main 侧 AI 超时必须用 `normalizeAiRateLimitConfig(config.rateLimit).requestTimeoutMs`（与 Renderer 同源），不要硬编码。
- 跨连接的异步结果必须做**代际校验**（`ObjectExplorer` 的 `epochRef` 模式）；不要用单个自增计数器给不同节点编号（会互相作废）。
- 日志：electron-log file transport 默认 `sync: true`；不使用其 `eventLogger`（会绕过本项目脱敏链路），改为手动注册事件走 `logService.append`。
- `settings:set` 有 key 白名单；`script:*` 强制绝对路径（`assertScriptPath`）。
- DeepSeek FIM 默认模型是 `deepseek-flash`（官方文档），不是 `deepseek-v4-pro`。
- **BIT 列归一化在 Main 侧完成**：`query-service.rowsToCells` 用 `/^bit\b/i` 识别列类型，48bit 以内（≤6 字节大端）转 number（BIT(1) → 0/1），超出或非安全整数则保持 Uint8Array。真正的 BLOB 一律保持二进制 → 前端 `formatCell` 的 `[二进制 N 字节]` 只应出现在真实二进制列上。
- **Excel 导出数值化规则**：仅数值型列（decimal/numeric/int/bigint/mediumint/smallint/tinyint/float/double/real）的字符串值转 number，且整数必须 `Number.isSafeInteger`、小数有效数字 ≤15，否则保持文本；`varchar`/`char` 的数字串（前导零、编码）一律不转。mysql2 对 DECIMAL 恒返回字符串，所以导出前必须做这一步，否则 Excel 里是文本、无法求和。

## UI / 设计体系

- **设计令牌唯一来源**：`src/renderer/styles/theme.css`（约 3311 行）。三套主题：`:root`（深色）/ `[data-theme="light"]` / `[data-theme="titanium"]`，靠 `document.documentElement.dataset.theme` 切换（`App.tsx` 的 `applyTheme`），设置持久化在 `settings:get/set('theme')`。
- **主题系统已验证健康**（2026-09-17 用 `getComputedStyle` 逐区域核对）：app-shell / sidebar / top-bar / main-area / monaco-editor / result-panel / grid-header / grid-body / status-bar 在三主题下全部正确变色。**不要再把"界面发黑"当作主题令牌问题去查**。
- Monaco 主题必须用 `monaco.editor.setTheme()`（`theme` 不是合法 editor option，`updateOptions({theme})` 会被静默忽略）；`onMount` 里必须读 `themeRef` 而非闭包 `theme`，否则会出现"白天模式启动却是深色、切换一次才正常"。
- **UI 阶段 1 已完成（2026-09-17）**，方向为 **Linear 基调 + IBM Carbon 表格规范**：三套主题改为明度阶梯 + **半透明边框**（深色画布 `#0f1011` / 面板 `#16181a` / 次级 `#1b1d20` / 边框 `rgba(255,255,255,.07/.13)`；浅色画布 `#f7f8f8`；钛灰 `#eef0f3`）；品牌色统一为靛紫家族 `#5e6ad2`（深）/ `#5b62d4`（浅）/ `#565fb8`（钛灰）；圆角 4/6/8；新增行高 `1.29/1.45/1.6`、字重 `400/510/590`（**全系统不用 700**）、字距 `0.16/0.32px` 令牌；`EditorTabs` 的**标签行与文件操作已合并为单行**（图标按钮，测试用 `getByTitle` 定位）；网格斑马纹/hover 改用 `--color-row-*` 专用令牌，数值列右对齐 + `tabular-nums`；Monaco 底色对齐画布、关键字对齐品牌色。
- **颜色判断只认计算样式**：曾两次因看缩略图误判（把浅色主题看成黑的、把靛紫关键字看成红色错误波浪线）。结论一律以 `getComputedStyle` 或像素取值为准；`tests/e2e/ui-audit.mjs` 已内置逐区域背景色 + Monaco token 取色 + squiggle 计数诊断。
- 阶段 2/3 待办见 `docs/UI打磨方案.md` §6.5（网格固定首列与列宽启发式、空态 CTA、连接表单吸底操作条、原生 `<select>` 自绘、状态栏警告降噪、命令面板 Ctrl+K、JetBrains Mono 落地）。
- `--font-mono: 'JetBrains Mono', Consolas` 但**包里没有该字体文件**（assets 只有 Monaco `codicon.ttf`，源码无 `@font-face`）→ 实际回退 Consolas；外观面板提供的字体名可能不存在。
- **UI 审计截图工具**：`npm run build && node tests/e2e/ui-audit.mjs` → 输出 `docs/ui-screenshots/audit/`（含逐区域背景色诊断，用于改造前后对比）。依赖 `playwright`（`npm i --no-save` 安装，未写入 `package.json`）+ Chromium 于 `~/AppData/Local/ms-playwright/`。
- **UI 设计参考库**（技能「品牌设计风格专家」）：`C:\Users\LANGYAO\.codebuddy\skills\品牌设计风格专家\references\*.md`，54 套真实品牌 DESIGN.md。数据密集桌面工具推荐 Linear / IBM Carbon / Raycast / Vercel。

## 架构与文档（2026-09-17 评审结论）

- **分层干净、不需要重构**：`renderer → @main` 0 处、`renderer → node:*` 0 处、`shared` 真实引用 0 处（零依赖，只可被引用）、`electron` 只在 `main/index.ts` / `main/ipc.ts` / `preload/index.ts`。服务层全部构造注入，14 个 service 均有单测且不连 MySQL。全仓 0 个 TODO/FIXME。
- **两处重复实现已于 2026-09-17 收敛（勿再复制出去）**：
  1. **标识符转义 → `src/shared/sql-ident.ts`**（唯一来源）。导出 `escapeIdentRaw`（只转义）/ `quoteIdent`（转义 + 反引号包裹）/ `quoteQualifiedIdent`（解析 `db.table` 并拒绝 `;` `()` 换行片段）。`sql-exporter` / `schema-cache` / `sql-utils` 三处已改引用；**不要在业务文件里再写 ``replace(/`/g, '``')``**。测试：`tests/shared/sql-ident.test.ts`。
  2. **列类型归一化 → `src/shared/column-type.ts`**。导出 `isNumericColumnType`（Excel 是否数值化 + 网格是否右对齐）/ `columnTypeFromRaw`（`SHOW FULL COLUMNS` 的 Type 字符串）/ `columnTypeFromCode`（mysql2 类型码）。**口径已统一：`longblob` → `blob`**（此前一处 `text` 一处 `blob`）。已知既有口径：含 `int` 子串的类型归 `int`（如 `point`），已在测试里显式记录以防被静默改动。
- **未使用依赖 `tdesign-react` 已移除**（2026-09-17，从 package.json 与 node_modules 一并清掉）。
- 其它维护热点：`App.tsx` 750 行（待办 #16）、`TableFieldsPanel.tsx` 245 行是**唯一无测试组件**、渲染层有 66 处 `window.sqlStudio` 直接调用。
- **文档体系（8 份）**：`架构文档.md`(436) / `开发文档.md`(489) / **`模块改动指南.md`(201)** / **`架构评审报告.md`(230)** / `待办与遗留问题.md`(145) / `e2e-checklist.md`(193) / `测试与发布验收规范.md`(123) / `UI打磨方案.md`(334)。
- **文档维护规则**：① 会漂移的数字（channel 数、文件行数、用例数）**只在一处维护**；② **新增模块必须登记到 `模块改动指南.md`**（否则下次改动退化成通读 1.2 万行源码）；③ 把重复实现收敛成单一来源后，要在该指南 §3 高危清单留一条防复发。

## 项目规模与仓库

- 仓库：`https://github.com/KingDoum/sql-studio.git`，分支 **`master`**（推送到 `origin/master`）。`.gitignore` 已覆盖 `node_modules/`、`dist/`、`release/`、`*.exe`，**打包产物不会入库**。
- 规模基线（2026-09-17）：**132 个文件 / 31,171 行** —— 源码 15,376（shared 1,518 / main 3,910 / renderer 9,899 含 css 3,380 / preload 49）、测试 9,721（含 e2e 1,538）、文档 5,506、配置 568。git 历史 64 次提交、累计新增 ≈48,168 行 / 删除 ≈8,554 行。
- 🔴 **`tests/e2e/ui-audit.mjs` 的假连接数据必须保持脱敏**（主机 `mysql-prod.internal.example.com`、账号 `demo_reader`）；不要把真实生产库主机/账号写回去，否则会随截图一起进公开仓库。
- **未入库目录**：`.codebuddy/`（AI 工作记忆）、`docs/ui-screenshots/audit/before/`（旧 UI 对比图，图内有真实主机名）。
- 打包后 `node_modules` 的 better-sqlite3 变 **Electron ABI**，再跑 `npm test` 前需 `npm install` 恢复 Node ABI（`npm run package:dir` 会自动重建为 Electron ABI，无须手动）。

## 文档基线

`docs/` 根目录只保留：`架构文档.md`、`开发文档.md`、`测试与发布验收规范.md`、`e2e-checklist.md`、`待办与遗留问题.md`（唯一待办清单）；历史执行类文档在 `docs/archive/`。
