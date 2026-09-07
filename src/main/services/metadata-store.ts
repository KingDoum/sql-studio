/**
 * 本地元数据存储（better-sqlite3）。
 *
 * 负责 connections / history 两表的 CRUD 与版本迁移。
 * 连接密码以密文落库（Security 注入）；对外只返回 ConnectionSummary（无密码）。
 *
 * ⚠️ 命名收藏（favorites）不在此处：按偏差决策 D1，收藏改为
 * `userData/queries/` 下的 .sql 文件库（见 favorites-store.ts），不再建表。
 *
 * 依赖注入：构造时传入 db 文件路径与 Security 实例，单测注入临时文件与 mock。
 */

import Database from 'better-sqlite3';
import { Security } from './security';
import { normalizeAiRateLimitConfig } from '@shared/ai-protocol';
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionSummary,
  HistoryItem,
} from '@shared/types';

const SCHEMA_VERSION = 2;

/**
 * 工作区恢复表 DDL（自动保存方案 §8.2）。
 * v1 → v2 迁移仅新增本组表/索引，不改现有表语义（方案 §19.2）。
 */
export const WORKSPACE_DDL = `
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
`;

export interface MetadataStoreDeps {
  dbPath: string;
  security: Security;
  /** 可选注入 better-sqlite3 构造器（便于单测替换为内存库）。 */
  createDb?: (path: string) => Database.Database;
}

export class MetadataStore {
  private readonly db: Database.Database;
  private readonly security: Security;

  constructor(deps: MetadataStoreDeps) {
    this.security = deps.security;
    const factory = deps.createDb ?? ((p: string) => new Database(p));
    this.db = factory(deps.dbPath);
    this.db.pragma('journal_mode = WAL');
    // 外键约束（方案 §8.2/§16.2 MS-09：孤立标签不可写入）
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /**
   * 受控共享连接（方案 §8.1/§14.1：独立 store 共用同一 SQLite 连接）。
   * 仅供 Main 服务注入（如 WorkspaceRecoveryStore）使用；
   * 不得经 IPC 暴露给 Renderer，不得用于执行任意上层 SQL。
   */
  getSharedDatabase(): Database.Database {
    return this.db;
  }

  // ─────────────────────────────────────────────────────────────
  // 迁移
  // ─────────────────────────────────────────────────────────────

  /**
   * 显式版本迁移（方案 §8.7）：
   * - v1 → v2：单事务内新增工作区表 + 更新版本；失败回滚且不删旧库。
   * - 已是 v2+：幂等补建表（跨版本重复启动不重复破坏性迁移）。
   */
  private migrate(): void {
    // 基础表（v1 既有；IF NOT EXISTS 幂等）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        user TEXT NOT NULL,
        password TEXT NOT NULL,
        database TEXT,
        charset TEXT NOT NULL DEFAULT 'utf8mb4',
        max_connections INTEGER,
        idle_timeout_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        connection_id TEXT,
        connection_name TEXT,
        sql TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        row_count INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        executed_at INTEGER NOT NULL
      );

      -- V2 预留：AI 配置（apiKey 密文存储），本次仅建表不使用
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const current = this.getVersion();
    if (current < SCHEMA_VERSION) {
      // v1 → v2（或更低 → v2）：单事务迁移；失败回滚，保持原版本可识别
      const runMigration = this.db.transaction(() => {
        this.db.exec(WORKSPACE_DDL);
        this.setVersion(SCHEMA_VERSION);
      });
      runMigration();
    } else {
      // 已是目标版本：幂等补建（CREATE TABLE IF NOT EXISTS 不重复破坏）
      this.db.exec(WORKSPACE_DDL);
    }
  }

  private setVersion(v: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(v));
  }

  getVersion(): number {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    this.db.close();
  }

  // ─────────────────────────────────────────────────────────────
  // 连接 CRUD
  // ─────────────────────────────────────────────────────────────

  private rowToConfig(row: any): ConnectionConfig {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      user: row.user,
      password: this.security.decrypt(row.password),
      database: row.database ?? undefined,
      charset: row.charset,
      maxConnections: row.max_connections ?? undefined,
      idleTimeoutMs: row.idle_timeout_ms ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private configToSummary(c: ConnectionConfig): ConnectionSummary {
    return {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      charset: c.charset,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  /** 保存连接（新增或更新）。返回对外摘要（无密码）。 */
  saveConnection(input: ConnectionInput & { id?: string }): ConnectionSummary {
    const now = Date.now();
    const id = input.id ?? crypto.randomUUID();
    const existing = input.id ? this.db.prepare('SELECT * FROM connections WHERE id = ?').get(input.id) : undefined;
    const createdAt = existing ? (existing as any).created_at : now;

    // 编辑时密码留空 → 保留原密码（契约：password 可选）
    const newPassword = input.password ?? '';
    const effectivePassword =
      input.id && existing && newPassword === ''
        ? (existing as any).password
        : this.security.encrypt(newPassword);

    this.db
      .prepare(
        `INSERT INTO connections
          (id, name, host, port, user, password, database, charset, max_connections, idle_timeout_ms, created_at, updated_at)
         VALUES (@id, @name, @host, @port, @user, @password, @database, @charset, @maxConnections, @idleTimeoutMs, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
          name=@name, host=@host, port=@port, user=@user, password=@password,
          database=@database, charset=@charset, max_connections=@maxConnections,
          idle_timeout_ms=@idleTimeoutMs, updated_at=@updatedAt`,
      )
      .run({
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        password: effectivePassword,
        database: input.database ?? null,
        charset: input.charset || 'utf8mb4',
        maxConnections: input.maxConnections ?? null,
        idleTimeoutMs: input.idleTimeoutMs ?? null,
        createdAt,
        updatedAt: now,
      });
    return this.configToSummary(this.getConfigById(id)!);
  }

  private getConfigById(id: string): ConnectionConfig | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as any;
    return row ? this.rowToConfig(row) : null;
  }

  /** 列出全部连接摘要（无密码）。 */
  listConnections(): ConnectionSummary[] {
    const rows = this.db.prepare('SELECT * FROM connections ORDER BY updated_at DESC').all() as any[];
    return rows.map((r) => this.configToSummary(this.rowToConfig(r)));
  }

  getConnection(id: string): ConnectionSummary | null {
    const c = this.getConfigById(id);
    return c ? this.configToSummary(c) : null;
  }

  /** 取主进程内部完整配置（含解密密码），仅限主进程使用。 */
  getConnectionConfig(id: string): ConnectionConfig | null {
    return this.getConfigById(id);
  }

  removeConnection(id: string): boolean {
    const res = this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // 历史
  // ─────────────────────────────────────────────────────────────

  addHistory(item: Omit<HistoryItem, 'id' | 'executedAt'>): HistoryItem {
    const id = crypto.randomUUID();
    const executedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO history
          (id, connection_id, connection_name, sql, success, row_count, elapsed_ms, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        item.connectionId ?? null,
        item.connectionName ?? null,
        item.sql,
        item.success ? 1 : 0,
        item.rowCount,
        item.elapsedMs,
        executedAt,
      );
    return { id, executedAt, ...item };
  }

  listHistory(opts: { connectionId?: string; limit?: number } = {}): HistoryItem[] {
    const limit = opts.limit ?? 200;
    let rows: any[];
    if (opts.connectionId) {
      rows = this.db
        .prepare('SELECT * FROM history WHERE connection_id = ? ORDER BY executed_at DESC LIMIT ?')
        .all(opts.connectionId, limit) as any[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM history ORDER BY executed_at DESC LIMIT ?')
        .all(limit) as any[];
    }
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id ?? undefined,
      connectionName: r.connection_name ?? undefined,
      sql: r.sql,
      success: !!r.success,
      rowCount: r.row_count,
      elapsedMs: r.elapsed_ms,
      executedAt: r.executed_at,
    }));
  }

  removeHistory(id: string): boolean {
    const res = this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // settings（V2 预留，本次仅提供读写）
  // ─────────────────────────────────────────────────────────────

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  // ─────────────────────────────────────────────────────────────
  // AiConfig（V2：加密存储 apiKey；阶段 3：Renderer 只见 AiPublicConfig）
  // ─────────────────────────────────────────────────────────────

  private readonly AI_CONFIG_KEY = 'ai_config';

  /** 读取 AiConfig（apiKey 经 security.decrypt 解密后返回，仅 Main 内部使用）。不存在返回 null。 */
  getAiConfig(): import('@shared/types').AiConfig | null {
    const raw = this.getSetting(this.AI_CONFIG_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as import('@shared/types').AiConfig;
      // 旧配置可能没有 rateLimit：自动补默认值（兼容旧数据，不失败）
      parsed.rateLimit = normalizeAiRateLimitConfig(parsed.rateLimit);
      if (parsed.apiKey) {
        const key = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
        parsed.apiKey = this.security.decrypt(key);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 读取 Renderer 可见的 AI 配置（阶段 3）：不含 apiKey 明文，仅含 apiKeyConfigured。
   * 绝不在任何 IPC 响应中返回解密后的 Key。
   * 阶段 A（外观与 AI 限流）：返回归一化后的 rateLimit，不含任何敏感数据。
   */
  getAiPublicConfig(): import('@shared/types').AiPublicConfig | null {
    const raw = this.getSetting(this.AI_CONFIG_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as import('@shared/types').AiConfig;
      return {
        enabled: !!parsed.enabled,
        baseUrl: parsed.baseUrl ?? '',
        model: parsed.model ?? '',
        protocol: parsed.protocol,
        apiKeyConfigured: !!(parsed.apiKey && typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0),
        // 旧配置无 rateLimit 时归一化会补默认值；越界/非数字也会被修正
        rateLimit: normalizeAiRateLimitConfig(parsed.rateLimit),
      };
    } catch {
      return null;
    }
  }

  /**
   * 保存 AiConfig（apiKey 经 security.encrypt 加密后落库）。
   * 阶段 3 安全规则：apiKey 为空/空白 → 保留旧密文（用户不能通过空输入意外清空 Key）；
   * 用户填写新 Key → 更新密文。
   * 阶段 A（外观与 AI 限流）：保存前归一化 rateLimit，越界/非数字值不会进入运行时配置。
   */
  setAiConfig(config: import('@shared/types').AiConfig): void {
    const newKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    let apiKeyToStore = '';
    if (newKey) {
      const encrypted = this.security.encrypt(newKey);
      apiKeyToStore = Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : String(encrypted);
    } else {
      // 空 Key：保留旧密文（原样复用，不再二次加密；不覆盖、不删除）
      const raw = this.getSetting(this.AI_CONFIG_KEY);
      if (raw) {
        try {
          const old = JSON.parse(raw) as import('@shared/types').AiConfig;
          apiKeyToStore = old.apiKey ?? '';
        } catch {
          apiKeyToStore = '';
        }
      }
    }
    const toStore: import('@shared/types').AiConfig = {
      ...config,
      apiKey: apiKeyToStore,
      rateLimit: normalizeAiRateLimitConfig(config.rateLimit),
    };
    this.setSetting(this.AI_CONFIG_KEY, JSON.stringify(toStore));
  }
}
