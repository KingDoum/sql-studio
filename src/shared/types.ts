/**
 * 跨进程共享类型（唯一来源，架构铁律 R5）。
 *
 * 主进程 / 预加载 / 渲染进程一律引用本文件，禁止各进程私自定义重复类型。
 * 密码字段仅主进程持有：渲染进程只见到 `ConnectionSummary`，绝不含 `password`。
 *
 * 任务 2（main-shared-types）初始化全部类型，并预留 AI 补全（V2）相关类型。
 */

// ─────────────────────────────────────────────────────────────
// 连接管理
// ─────────────────────────────────────────────────────────────

/** 主进程内部持有的完整连接配置（含明文密码，绝不外发到渲染进程）。 */
export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** 明文仅在内存/解密后存在，落库为密文；此字段不进入任何 IPC 响应。 */
  password: string;
  database?: string;
  charset: string;
  /** 连接池参数 */
  maxConnections?: number;
  idleTimeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

/** 新建/编辑连接时由渲染进程提交的输入（不含 id 与时间戳）。 */
export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  charset: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
}

/** 渲染进程可见的连接摘要（不含密码）。 */
export interface ConnectionSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  charset: string;
  createdAt: number;
  updatedAt: number;
}

/** 测试连接结果（统一成功/失败结构）。 */
export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** 错误归类，便于 UI 给出友好提示（超时/拒绝/认证失败等）。 */
  errorType?: 'timeout' | 'refused' | 'auth' | 'unknown';
}

// ─────────────────────────────────────────────────────────────
// Schema（库 / 表 / 字段 / DDL）
// ─────────────────────────────────────────────────────────────

export type ColumnType =
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'double'
  | 'varchar'
  | 'char'
  | 'text'
  | 'datetime'
  | 'date'
  | 'timestamp'
  | 'time'
  | 'json'
  | 'blob'
  | 'boolean'
  | 'enum'
  | string;

/** 字段元数据。 */
export interface ColumnMeta {
  name: string;
  type: ColumnType;
  nullable: boolean;
  isPrimary: boolean;
  isUnique: boolean;
  defaultValue?: string | null;
  comment?: string;
  /** 字符集（字符类型才有），用于语义高亮与补全。 */
  charset?: string;
  /** 结果集字段来源表名（mysql2 field.orgTable），用于主进程回填列注释。 */
  tableName?: string;
}

/** 表的元数据。 */
export interface TableMeta {
  name: string;
  type: 'table' | 'view';
  engine?: string;
  comment?: string;
  rowCount?: number;
  /** 仅视图为 true；表为 false/undefined。 */
  isView?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 查询结果
// ─────────────────────────────────────────────────────────────

/** 单元格值：NULL 用 null 表示，二进制用 Uint8Array。 */
export type CellValue = string | number | boolean | null | Uint8Array;

/** 单个结果集（一条 SQL 语句的产出）。 */
export interface QueryResultSet {
  /** 结果集序号（0 起，对应多语句中的第几条）。 */
  index: number;
  /** SQL 语句（脱敏后的摘要，非完整原文）。 */
  statement: string;
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** 影响行数（写类语句有意义；查询类为 0）。 */
  affectedRows: number;
  /** 是否因超过 MAX_RESULT_ROWS 被截断。 */
  truncated: boolean;
  /** 执行耗时（毫秒）。 */
  elapsedMs: number;
}

/** 一次执行（可能含多条语句）的聚合结果。 */
export interface QueryResult {
  connectionId: string;
  /** 多结果集，按语句顺序。 */
  resultSets: QueryResultSet[];
  /** 总耗时（毫秒）。 */
  totalElapsedMs: number;
  /** 是否被截断（任一结果集 truncated 即 true）。 */
  truncated: boolean;
  /** 是否含写类语句（用于 UI 提示）。 */
  hasWrite: boolean;
}

/** 查询执行请求参数。 */
export interface QueryRequest {
  connectionId: string;
  sql: string;
  /** 指定数据库（可选，覆盖连接的默认库）。 */
  database?: string;
  /** 仅执行选区时，由渲染进程给出的语句（已裁剪）。 */
  statement?: string;
  /** 行数上限保护（默认由主进程常量 MAX_RESULT_ROWS 决定）。 */
  maxRows?: number;
  /** 客户端生成的查询 id，用于取消执行时匹配（渲染进程零直连：clientQueryId 由渲染进程生成，不接触密码）。 */
  clientQueryId?: string;
}

// ─────────────────────────────────────────────────────────────
// 编辑器 / 脚本 / 标签页
// ─────────────────────────────────────────────────────────────

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  /** 已保存的文件路径；未保存为 undefined。 */
  filePath?: string;
  isDirty: boolean;
  /** 该 Tab 关联的当前连接（可选，可被全局当前连接覆盖）。 */
  connectionId?: string;
}

/** 脚本文件读写结果。 */
export interface ScriptFileResult {
  filePath: string;
  content: string;
}

/** 保存脚本请求。 */
export interface ScriptSaveRequest {
  filePath?: string;
  content: string;
}

// ─────────────────────────────────────────────────────────────
// 历史 / 收藏
// ─────────────────────────────────────────────────────────────

export interface HistoryItem {
  id: string;
  connectionId: string;
  connectionName?: string;
  sql: string;
  /** 执行成功/失败。 */
  success: boolean;
  /** 影响/返回行数摘要。 */
  rowCount: number;
  elapsedMs: number;
  executedAt: number;
}

/**
 * 命名收藏（文件型，对齐用户对旧项目 history.py 的不满）。
 *
 * 收藏不再存 SQLite，而是落在 `queries/` 文件夹下、以「收藏名.sql」命名的文件里，
 * 用户可直接在文件管理器浏览/搜索/复用，文件本身即可被编辑器打开运行。
 * 元信息写在 .sql 文件顶部注释块（见下方 FAVORITE_HEADER 约定），SQL 保持纯净可读。
 *
 * - filePath：该收藏 .sql 文件的绝对路径（唯一标识来源，替代旧 id）。
 * - name：由文件名（去 .sql 后缀）派生，作为显示名与列表主键。
 * - sql：文件正文（已剥离顶部注释块后的纯 SQL）。
 * - connectionId / tags / createdAt / updatedAt：来自文件顶部注释块，缺省时给合理默认。
 */
export interface FavoriteItem {
  /** .sql 文件绝对路径（收藏的唯一标识，替代旧项目的 id）。 */
  filePath: string;
  /** 收藏名 = 文件名去 .sql 后缀。 */
  name: string;
  /** 文件正文（剥离顶部注释块后的纯 SQL）。 */
  sql: string;
  /** 关联连接 id（来自注释块，可选）。 */
  connectionId?: string;
  /** 标签（来自注释块，可选），便于分类检索。 */
  tags?: string[];
  /** 创建时间（来自注释块，缺省回退文件 mtime）。 */
  createdAt: number;
  /** 更新时间（文件 mtime）。 */
  updatedAt: number;
}

/**
 * 收藏 .sql 文件顶部注释块约定（元信息区）。
 * 形如：
 *   -- name: 每日活跃用户统计
 *   -- connection: conn_abc123
 *   -- tags: 活跃, 日报
 *   -- createdAt: 2026-08-20T10:00:00.000Z
 *   -- (空行后接纯 SQL)
 * 解析时按 `-- key: value` 提取；name 缺省回退文件名；SQL 为正文剩余部分。
 */
export const FAVORITE_HEADER_KEYS = {
  name: 'name',
  connection: 'connection',
  tags: 'tags',
  createdAt: 'createdAt',
} as const;

/** 收藏保存请求：以文件名（收藏名）为标识，而非 id。 */
export interface FavoriteSaveRequest {
  /** 收藏名（将作为文件名，去/补 .sql）。 */
  name: string;
  sql: string;
  connectionId?: string;
  tags?: string[];
}

// ─────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────

/** Excel 导出选项。 */
export interface ExcelOptions {
  /** 目标文件路径（.xlsx）。 */
  filePath: string;
  /** 工作表名。 */
  sheetName?: string;
  /** 表头中文说明（可选，作为首行注释之外的标题）。 */
  title?: string;
  /** 是否冻结首行（默认 true，对齐旧项目 exporter.py）。 */
  freezeHeader?: boolean;
  /** 是否包含导出元信息（连接/时间），默认 true。 */
  includeMeta?: boolean;
}

/** SQL INSERT 导出选项。 */
export interface SqlInsertOptions {
  filePath: string;
  /** 目标表名（生成 INSERT INTO <table> ...）。 */
  tableName: string;
  /** 每批 INSERT 的行数，默认 500。 */
  batchSize?: number;
  /** 字段名（顺序对应结果集列）。 */
  columns?: string[];
}

/** CSV 导出选项。 */
export interface CsvOptions {
  filePath: string;
  /** 是否包含表头行（默认 true）。 */
  includeHeader?: boolean;
}

/** 导出请求：携带要导出的结果数据 + 选项。 */
export interface ExportExcelRequest {
  options: ExcelOptions;
  columns: ColumnMeta[];
  rows: CellValue[][];
}

export interface ExportInsertRequest {
  options: SqlInsertOptions;
  columns: ColumnMeta[];
  rows: CellValue[][];
}

export interface ExportCsvRequest {
  options: CsvOptions;
  columns: ColumnMeta[];
  rows: CellValue[][];
}

export interface ExportResult {
  filePath: string;
  rowCount: number;
}

// ─────────────────────────────────────────────────────────────
// 通用响应包装
// ─────────────────────────────────────────────────────────────

/** 原生保存对话框选项（导出/另存为共用）。 */
export interface ShowSaveDialogOptions {
  /** 默认文件名/路径（可含目录）。 */
  defaultPath?: string;
  /** 文件类型过滤器。 */
  filters?: Array<{ name: string; extensions: string[] }>;
  /** 对话框标题。 */
  title?: string;
}

/** 原生打开文件对话框选项。 */
export interface ShowOpenDialogOptions {
  /** 默认打开目录。 */
  defaultPath?: string;
  /** 文件类型过滤器。 */
  filters?: Array<{ name: string; extensions: string[] }>;
  /** 对话框标题。 */
  title?: string;
}

/** 主进程 handler 统一返回结构：成功返回 data，失败返回 error。 */
export interface IpcResult<T> {
  ok: true;
  data: T;
}

export interface IpcError {
  ok: false;
  error: string;
  /** 可选错误归类。 */
  errorType?: string;
}

export type IpcResponse<T> = IpcResult<T> | IpcError;

// ─────────────────────────────────────────────────────────────
// AI 智能补全（V2 预留，V1 不实装，仅定义接口与占位）
// ─────────────────────────────────────────────────────────────

/**
 * 可插拔补全 provider 接口。
 * V1 实装 `SchemaCompletionProvider`（规则补全：关键字 + 库/表/字段名）；
 * V2 新增 `AiCompletionProvider`（AI 行内补全），并列注册、可切换，
 * 不影响已有规则补全（架构铁律要求）。
 */
export interface CompletionProvider {
  /** provider 标识。 */
  readonly kind: 'schema' | 'ai';
  /**
   * 给定上下文，返回补全候选。
   * @param context 当前 SQL 前缀、光标位置附近 token、已连接 schema 信息。
   */
  provideCompletions(context: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}

/** 补全上下文（供 schema 与 ai provider 共用）。 */
export interface CompletionContext {
  /** 光标前的 SQL 文本。 */
  prefix: string;
  /** 当前正在输入的词（可能是空串）。 */
  word: string;
  /** 当前连接 id（可能为 undefined，未连库时仅关键字补全）。 */
  connectionId?: string;
  /** 当前数据库（可选）。 */
  database?: string;
  /** 整篇 SQL（可选，用于从全文提取 FROM 子句，实现字段位置跨语句补全）。 */
  document?: string;
}

/** 补全项分类，用于图标与配色区分。 */
export type CompletionCategory = 'keyword' | 'database' | 'table' | 'column' | 'function' | 'ai';

/** 单个补全候选项。 */
export interface CompletionItem {
  label: string;
  category: CompletionCategory;
  /** 插入文本（默认等于 label）。 */
  insertText?: string;
  /** 文档提示（悬停说明）。 */
  detail?: string;
  /** 排序权重，越大越靠前。 */
  score?: number;
}

/**
 * AI 补全协议。
 * - `deepseek-fim`：DeepSeek 官方 FIM 接口（/beta/completions，请求体 prompt+suffix，响应 choices[0].text）。
 * - `openai-chat`：OpenAI 兼容 Chat 接口（/v1/chat/completions，响应 choices[0].message.content）。
 *
 * 阶段 1（FIM 协议修复）：不再以 URL 猜测协议，显式携带 protocol。
 */
export type AiProtocol = 'deepseek-fim' | 'openai-chat';

/**
 * AI 请求策略（限流参数，Main 与 Renderer 共用唯一默认值/归一化逻辑）。
 *
 * 统一默认值、允许范围与归一化在 `src/shared/ai-protocol.ts`
 * （`DEFAULT_AI_RATE_LIMIT_CONFIG` / `normalizeAiRateLimitConfig`）。
 * 这些参数只控制「客户端请求频率」，不控制输出长度（maxTokens 单独钳制）。
 */
export interface AiRateLimitConfig {
  /** 输入防抖（ms）：停止输入多久后才发起请求。默认 400，范围 150-3000。 */
  debounceMs: number;
  /** 最小请求间隔（ms）：两次实际请求之间的最短间隔。默认 2500，范围 500-30000。 */
  minRequestIntervalMs: number;
  /** 限流冷却时间（ms）：收到 429/服务过载后的暂停时间。默认 15000，范围 1000-120000。 */
  rateLimitCooldownMs: number;
  /** 请求超时（ms）：Renderer 等待 AI IPC 结果的最长时间。默认 12000，范围 3000-60000。 */
  requestTimeoutMs: number;
}

/** AI 配置（Main 内部使用，含明文 API Key；绝不经普通 IPC 返回 Renderer）。 */
export interface AiConfig {
  /** 是否启用 AI 补全。 */
  enabled: boolean;
  /** API BaseURL（如 https://api.deepseek.com/beta）。 */
  baseUrl: string;
  /** 模型名（如 deepseek-v4-pro）。 */
  model: string;
  /**
   * API Key。V2 经 safeStorage 加密后落 SQLite settings 表；
   * 内存传递时可为明文，仅 Main 进程持有（阶段 3：Renderer 不再看到 apiKey）。
   */
  apiKey: string;
  /**
   * 补全协议。可选：兼容旧配置（无 protocol 时按 baseUrl 含 /beta 推断为 FIM，否则 Chat）。
   */
  protocol?: AiProtocol;
  /**
   * 请求策略（可选）。旧配置没有该字段时，读取端自动补 `DEFAULT_AI_RATE_LIMIT_CONFIG`；
   * 保存端会先归一化再落库，保证越界/非数字值不会进入运行时配置。
   */
  rateLimit?: AiRateLimitConfig;
}

/**
 * Renderer 可见的 AI 配置（阶段 3：绝不含 apiKey）。
 * 仅用于设置面板展示与 ai-provider 可用性判断。
 */
export interface AiPublicConfig {
  /** 是否启用 AI 补全。 */
  enabled: boolean;
  /** API BaseURL（如 https://api.deepseek.com/beta）。 */
  baseUrl: string;
  /** 模型名（如 deepseek-v4-pro）。 */
  model: string;
  /** 补全协议（可选，兼容旧配置推断）。 */
  protocol?: AiProtocol;
  /** API Key 是否已配置（true=已保存过 Key，供 UI 显示"已配置"而非泄露内容）。 */
  apiKeyConfigured: boolean;
  /** 请求策略（归一化后的安全值，不含任何敏感数据）。 */
  rateLimit: AiRateLimitConfig;
}

/** AI 补全请求（V2 使用，`ai.complete` channel 占位）。 */
export interface AiCompletionRequest {
  connectionId?: string;
  prefix: string;
  suffix?: string;
  maxTokens?: number;
}

export interface AiCompletionResponse {
  /** 行内补全建议文本（灰色预测）。 */
  suggestion: string;
  /**
   * 非敏感响应元信息（阶段 D：区分「模型空返回」与「客户端限流」）。
   * 只包含 choice 数量、finish reason、usage token 数等诊断字段；
   * 绝不包含 prompt/suffix/SQL/API Key/Authorization。
   * 可选：旧调用方忽略该字段，不影响契约。
   */
  meta?: {
    /** choices 数组长度（0 = 服务端未返回任何候选）。 */
    choiceCount: number;
    /** 第一个 choice 的 finish_reason（如 stop/length/null）。 */
    finishReason?: string;
    /** usage token 数（服务端提供时才存在）。 */
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
}

// ─────────────────────────────────────────────────────────────
// 主题
// ─────────────────────────────────────────────────────────────

/**
 * 界面主题模式。
 * - `dark`：深色（默认）
 * - `light`：白天
 * - `titanium`：钛灰（苹果式克制中性灰，独立令牌，2026-09-01 外观升级新增）
 */
export type ThemeMode = 'dark' | 'light' | 'titanium';

// ─────────────────────────────────────────────────────────────
// 工作区恢复快照（自动保存方案 §9.1）
// ─────────────────────────────────────────────────────────────

/** 工作区 schema 版本（与数据库 schema version 分开管理，方案 §11.10）。 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/** 单标签恢复快照（规范化行，方案 §9.1）。 */
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

/** 完整工作区快照（restore 提示与 save 请求共用，方案 §9.1）。 */
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

// ─────────────────────────────────────────────────────────────
// 持久日志（方案 §9.2）
// ─────────────────────────────────────────────────────────────

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
