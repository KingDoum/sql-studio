# SQL Studio

面向数据分析师的桌面级 SQL 工具平台（对标 Navicat/DataGrip），基于 Electron + React + Monaco 构建。

![Electron](https://img.shields.io/badge/Electron-37.10.3-blue?logo=electron)
![React](https://img.shields.io/badge/React-18.3.1-blue?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)
![MySQL](https://img.shields.io/badge/MySQL-8.0-blue?logo=mysql)

## 功能

- **多数据库连接管理**：MySQL/MariaDB 连接 CRUD、测试连接、密码 safeStorage 加密存储
- **SQL 编辑器**：Monaco 编辑器（VS Code 内核）、语法高亮、schema 感知补全（表名/字段名/库名，支持跨库）、语义化高亮、SQL 格式化、Ctrl+Enter 执行、Ctrl+S 保存
- **AI SQL 补全**：行内灰色建议，支持 DeepSeek FIM 与 OpenAI Chat 双协议；请求策略（防抖/最小间隔/冷却/超时）可调
- **右侧表字段导航**：自动识别当前 SQL 用到的表（含子查询、跨库），点表展开字段+注释、点字段插入字段名
- **多标签页**：新建/打开/保存/另存为、脏标记、关闭确认
- **对象浏览器**：库→表→字段树形浏览、懒加载、双击表生成 SELECT、数据预览、表名/库名模糊筛选
- **查询结果**：多结果集、虚拟滚动大数据表格、排序/筛选/双击复制、NULL/二进制格式化、截断保护、结果历史（保留最近 10 次）、横向/纵向滚动
- **数据导出**：Excel（表头样式/冻结窗格/自动列宽）、CSV（BOM + 公式注入防护）、SQL INSERT（标识符转义）；导出与脚本另存为的默认文件名自动带日期时间（`导出结果_20260916_173045.xlsx`），不改名可直接回车保存
- **执行历史与命名收藏**：自动记录、SQL 回填编辑器、文件式收藏（`userData/queries/*.sql`）
- **写操作确认**：INSERT/UPDATE/DELETE/CTE 写/CALL 等执行前二次确认（共享分类模块，Main 与 Renderer 一致）
- **自动保存与工作区恢复**：标签、顺序、脏标记、当前连接自动快照；异常退出后可恢复；不写真实 `.sql` 文件
- **持久化调试日志**：electron-log 落盘 `userData/logs/`，JSON 行格式、轮转 10MiB/5 归档/14 天、双层脱敏（无密码/API Key/完整 SQL）、北京时间展示
- **三套主题**：深色 / 白天 / 钛灰，字号 10-30 可调

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（自动化构建 + 启动 Electron）
npm run dev

# 类型检查
npm run typecheck

# 运行测试
npm test

# 生产构建
npm run build

# 打包 Windows 安装包（需在 Windows 上执行）
npm run package
```

## 技术栈

| 类别 | 选型 | 版本 |
|---|---|---|
| 桌面壳 | Electron | ^37.0.0 |
| 构建 | Vite 5 | ^5.4.0 |
| 渲染框架 | React 18 + TypeScript 5 | ^18.3.1 / ^5.6.0 |
| SQL 编辑器 | @monaco-editor/react | ^4.6.0 |
| 数据库驱动 | mysql2 | ^3.11.0 |
| 本地元数据 | better-sqlite3 | ^12.11.1 |
| 持久日志 | electron-log | ^5.2.0 |
| 导出 | ExcelJS | ^4.4.0 |
| SQL 美化 | sql-formatter | ^15.4.0 |
| UI 组件 | tdesign-react | ^1.9.3 |
| 图标 | lucide-react | ^0.454.0 |
| 状态管理 | zustand | ^4.5.5 |
| 测试 | vitest + @testing-library/react | ^2.1.0 |
| 打包 | electron-builder (NSIS) | ^24.13.3 |

## 项目结构

```
sql-studio/
├── package.json
├── tsconfig.json
├── vite.config.ts          # 渲染进程构建
├── vite.main.config.ts     # 主进程/preload 构建
├── vitest.config.ts        # 测试配置
├── electron-builder.yml    # 打包配置
├── src/
│   ├── shared/             # 跨进程共享类型与 IPC 契约
│   │   ├── types.ts        # 类型唯一来源
│   │   ├── ipc-contract.ts # IPC channel 常量与请求/响应类型
│   │   ├── sql-classify.ts # 写操作识别（Main/Renderer 共享）
│   │   └── ai-protocol.ts  # AI 协议与 BaseURL 归一化
│   ├── main/               # 主进程（Node.js）
│   │   ├── index.ts        # 入口与生命周期
│   │   ├── ipc.ts          # IPC 路由注册（41 个 channel）
│   │   └── services/       # 连接池/查询/schema 缓存/元数据/工作区/日志/导出
│   ├── preload/            # contextBridge 类型化 API
│   │   └── index.ts
│   └── renderer/           # 渲染进程（React UI）
│       ├── App.tsx         # 工作台主组件
│       ├── components/     # 连接/浏览器/编辑器/结果/导出/历史/收藏/外观
│       ├── lib/            # 纯逻辑（SQL 工具/补全/持久化/日志桥）
│       ├── store/          # zustand 状态管理
│       └── styles/         # 设计令牌与主题 CSS
├── tests/                  # 平行于 src 的测试目录
│   ├── main/               # 主进程单测（mock 数据库）
│   ├── renderer/           # 组件测试（jsdom + mock IPC）
│   ├── shared/             # 契约测试
│   └── e2e/                # Playwright 无头 E2E 脚本
└── docs/
    ├── 架构文档.md              # 系统架构与技术基线
    ├── 开发文档.md              # 开发/维护/验证手册
    ├── 测试与发布验收规范.md     # 测试分层与发布门
    ├── e2e-checklist.md         # Windows 真机验收清单
    ├── 待办与遗留问题.md         # 唯一待办清单
    ├── archive/                 # 已完成的执行计划/方案/验收报告
    └── ui-screenshots/          # 历史 UI 验收截图
```

## 架构

三进程单向分层架构：

```
渲染进程 (React) → preload (contextBridge) → 主进程 (Node.js) → MySQL / SQLite / 文件系统
```

- **渲染进程**：React 界面（Monaco 编辑器、结果表格、连接管理），不直接接触数据库
- **preload**：类型化 IPC 桥接，暴露 `window.sqlStudio` 类型化 API
- **主进程**：连接池管理、SQL 查询执行、schema 缓存、元数据/工作区存储、持久日志、文件读写、导出生成

详细架构设计见 `docs/架构文档.md`。

## 开发说明

- 开发环境需 Node.js 22+、npm 10+
- 主进程构建输出 `.cjs`（CJS 格式，Electron 要求）
- 组件测试文件头部加 `// @vitest-environment jsdom`
- **本地打包**：`better-sqlite3` 已升级到提供 Electron 37（ABI 136）预编译包的版本，因此**无需安装 Visual Studio C++ 工具链**即可本地 `npm run package`；若原生模块 ABI 报错，先执行 `npm run rebuild`
- 详细开发手册见 `docs/开发文档.md`，待办与已知问题见 `docs/待办与遗留问题.md`

## 测试

```bash
# 全量测试
npm test

# 仅渲染进程测试
npx vitest run tests/renderer/

# 仅主进程测试
npx vitest run tests/main/

# 监听模式
npm run test:watch

# 无头 E2E（需先 npm run build）
node tests/e2e/ui-layout-check.mjs
node tests/e2e/workspace-recovery-check.mjs
```

## 打包

```bash
# Windows 安装包（需在 Windows 上执行）
npm run package
```

产物输出到 `release/` 目录，包含 NSIS 安装程序。

## 许可

MIT
