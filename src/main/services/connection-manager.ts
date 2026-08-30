/**
 * 连接池管理（任务 4 main-connection）。
 *
 * 职责：
 *   1. 按连接 id 创建并复用 mysql2 连接池（pool-per-connection）。
 *   2. 空闲超时自动销毁池，释放资源。
 *   3. testConnection：用临时单连接验证，不进池，避免污染。
 *   4. 错误规范化：把 mysql2 底层错误码映射为友好中文消息。
 *   5. 执行入口：通过池获取连接执行 SQL（具体查询逻辑在 query-service）。
 *
 * 安全：密码仅主进程持有（架构铁律 R6）。本模块接收的是已解密的明文
 * ConnectionConfig（解密在 metadata-store / IPC 处理层完成），绝不下发渲染进程。
 *
 * 依赖注入：构造函数注入 mysql2 工厂（createPool / createConnection），
 * 单测传入 mock 工厂，无需真实 MySQL，也无需真实 Electron。
 */

import type { ConnectionConfig, ConnectionInput, TestConnectionResult } from '@shared/types';

/** mysql2 行结果类型（宽松，具体列在 query-service 解析）。 */
export type QueryRow = Record<string, unknown>;

/** 池内连接对象的最小接口（与 mysql2 pool 兼容，便于 mock）。 */
export interface PooledConnection {
  query(sql: string, params?: unknown[]): Promise<[QueryRow[], unknown]>;
  execute(sql: string, params?: unknown[]): Promise<[QueryRow[], unknown]>;
  release(): void;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** mysql2 连接池的最小接口。 */
export interface PoolLike {
  getConnection(): Promise<PooledConnection>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<[QueryRow[], unknown]>;
}

/** 单个原始结果集（executeMany 返回元素）。 */
export interface RawResultSet {
  rows: QueryRow[];
  fields: unknown;
  /** 写类语句的影响行数。 */
  affectedRows: number;
  /** 是否为写类语句（无字段元信息即视为写类）。 */
  isWrite: boolean;
}

/** 单连接（createConnection 返回）最小接口。 */
export interface SingleConnectionLike extends PooledConnection {
  end(): Promise<void>;
}

/** mysql2 工厂：构造时注入，默认指向真实 mysql2 实现。 */
export interface Mysql2Factory {
  createPool(config: Record<string, unknown>): PoolLike;
  createConnection(config: Record<string, unknown>): Promise<SingleConnectionLike>;
}

/** 集中池配置常量（铁律 R5：参数单一来源）。 */
export const POOL_CONFIG = {
  /** 默认连接池上限（可被 ConnectionConfig.maxConnections 覆盖）。 */
  MAX_CONNECTIONS: 10,
  /** 空闲超时（毫秒）：超过此时间无访问则销毁池。 */
  IDLE_TIMEOUT_MS: 5 * 60 * 1000,
  /** 连接超时（毫秒）：建立连接的最长等待。 */
  CONNECT_TIMEOUT_MS: 10 * 1000,
  /** 默认字符集。 */
  CHARSET: 'utf8mb4',
} as const;

/** 池条目：记录池、定时器与最近访问时间。 */
interface PoolEntry {
  pool: PoolLike;
  timer: NodeJS.Timeout | null;
  lastUsed: number;
}

export class ConnectionManager {
  private readonly factory: Mysql2Factory;
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly pools = new Map<string, PoolEntry>();

  constructor(
    factory: Mysql2Factory,
    options?: { maxConnections?: number; idleTimeoutMs?: number },
  ) {
    this.factory = factory;
    this.maxConnections = options?.maxConnections ?? POOL_CONFIG.MAX_CONNECTIONS;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? POOL_CONFIG.IDLE_TIMEOUT_MS;
  }

  /** 把内部 ConnectionConfig 转为 mysql2 建池配置（密码保留明文，仅主进程）。 */
  private toMysqlConfig(config: ConnectionConfig): Record<string, unknown> {
    return {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: config.charset || POOL_CONFIG.CHARSET,
      connectionLimit: config.maxConnections ?? this.maxConnections,
      connectTimeout: POOL_CONFIG.CONNECT_TIMEOUT_MS,
      // 时区统一，避免 TIMESTAMP 显示偏移
      timezone: 'local',
      // 支持多语句由 query-service 按需控制，此处保持默认（false）更安全
      multipleStatements: false,
    };
  }

  private toTestConfig(input: ConnectionInput): Record<string, unknown> {
    return {
      host: input.host,
      port: input.port,
      user: input.user,
      password: input.password ?? '',
      database: input.database,
      charset: input.charset || POOL_CONFIG.CHARSET,
      connectTimeout: POOL_CONFIG.CONNECT_TIMEOUT_MS,
      // 测试连接：连接即用即弃，避免长期占用
      connectionLimit: 1,
      multipleStatements: false,
    };
  }

  /**
   * 取得（或创建）某连接的池。按 id 复用；访问时刷新空闲计时器。
   * 空闲 idleTimeoutMs 无访问则自动 end() 并移出 Map。
   */
  getPool(config: ConnectionConfig): PoolLike {
    const existing = this.pools.get(config.id);
    if (existing) {
      this.touch(existing);
      return existing.pool;
    }
    const pool = this.factory.createPool(this.toMysqlConfig(config));
    const entry: PoolEntry = { pool, timer: null, lastUsed: Date.now() };
    this.pools.set(config.id, entry);
    this.touch(entry);
    return pool;
  }

  /** 刷新空闲计时器。 */
  private touch(entry: PoolEntry): void {
    entry.lastUsed = Date.now();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.destroyPool(entry);
    }, this.idleTimeoutMs);
    // 不阻止进程退出
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  /** 销毁指定池条目（end + 从 Map 移除）。 */
  private async destroyPool(entry: PoolEntry): Promise<void> {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await entry.pool.end();
    } catch {
      // 已销毁或连接已断开，忽略
    }
    // 从 Map 移除：仅当该条目仍是同一实例时才删（避免误删新建池）
    for (const [id, e] of this.pools) {
      if (e === entry) this.pools.delete(id);
    }
  }

  /** 主动关闭某连接池（如连接被删除时）。 */
  async closePool(connectionId: string): Promise<void> {
    const entry = this.pools.get(connectionId);
    if (entry) await this.destroyPool(entry);
  }

  /** 关闭所有池（应用退出时）。 */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.pools.values());
    await Promise.all(entries.map((e) => this.destroyPool(e)));
  }

  /**
   * 测试连接：用临时单连接，成功返回 {ok:true}，失败规范化错误。
   * 不进池、不影响现有池状态。
   */
  async testConnection(input: ConnectionInput): Promise<TestConnectionResult> {
    let conn: SingleConnectionLike | null = null;
    try {
      conn = await this.factory.createConnection(this.toTestConfig(input));
      // 发一个轻量探活查询，验证认证与可达性
      await conn.query('SELECT 1');
      return { ok: true, message: '连接成功' };
    } catch (err) {
      return { ok: false, message: normalizeConnectionError(err) };
    } finally {
      if (conn) {
        try {
          await conn.end();
        } catch {
          // 忽略关闭失败
        }
      }
    }
  }

  /**
   * 执行入口：获取池连接执行 SQL，自动归还。
   * 具体结果解析在 query-service（任务 5），这里只负责拿到连接并跑查询。
   */
  async execute(
    config: ConnectionConfig,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: QueryRow[]; fields: unknown }> {
    const pool = this.getPool(config);
    const conn = await pool.getConnection();
    try {
      const [rows, fields] = await conn.execute(sql, params);
      return { rows: rows as QueryRow[], fields };
    } finally {
      conn.release();
    }
  }

  /**
   * 多语句执行：对含多条语句的 SQL，用临时单连接（multipleStatements=true）
   * 一次执行，返回多个结果集。临时连接用完即 end，不长期开启多语句池。
   *
   * mysql2 在 `query(sql)` 下返回统一的 `[rowsOrList, fieldsOrList]` 结构：
   *   - 单语句 SELECT → `[rows, fields]`
   *   - 单语句写（INSERT/UPDATE/DELETE…）→ `[ResultSetHeader, undefined]`
   *   - 多语句混合 → `[rowsList, fieldsList]`，其中 rowsList[i] 为第 i 条语句的
   *     rows（SELECT）或 ResultSetHeader（写类），fieldsList[i] 为对应 fields 或 undefined。
   * 本方法把其归一化为 RawResultSet[]；每个元素独立成集，header 的 affectedRows
   * 被读取（不再把多语句折叠成一个混入 header 的结果集）。
   *
   * @param config 已解密连接配置
   * @param sql 可能含多条语句的 SQL
   */
  async executeMany(config: ConnectionConfig, sql: string, signal?: AbortSignal): Promise<RawResultSet[]> {
    const conn = await this.factory.createConnection({
      ...this.toMysqlConfig(config),
      multipleStatements: true,
      connectionLimit: 1,
    });
    const hardDestroy = () => {
      // 硬销毁底层 socket：mysql2 的 conn.destroy() 只是 stream.end()（优雅关闭），
      // 服务端查询仍会继续执行、客户端 promise 约数秒后才 settle（且会 resolve 成"正常结果"），
      // 导致取消后可能错误写入历史。stream.destroy() 会让挂起查询立即 reject。
      try {
        const stream = (conn as unknown as { stream?: { destroy(): void } }).stream;
        stream?.destroy();
      } catch { /* ignore */ }
      try {
        (conn as unknown as { destroy(): void }).destroy();
      } catch { /* ignore */ }
    };
    // 取消信号 → 立即本地 reject + 硬销毁连接（中止 MySQL 查询）
    if (signal) {
      if (signal.aborted) {
        try { await conn.end(); } catch {}
        throw new DOMException('已取消', 'AbortError');
      }
    }
    try {
      const queryPromise = (conn as unknown as { query(sql: string): Promise<unknown> }).query(sql);
      let result: unknown;
      if (signal) {
        result = await new Promise<unknown>((resolve, reject) => {
          const onAbort = () => {
            hardDestroy();
            reject(new DOMException('已取消', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          queryPromise.then(
            (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
          );
        });
      } else {
        result = await queryPromise;
      }
      return normalizeExecuteResult(result as [unknown, unknown]);
    } finally {
      // 清理 signal 监听由上面的 removeEventListener 完成；连接最终 end 释放
      try {
        await conn.end();
      } catch {
        // 忽略
      }
    }
  }

  /** 当前已缓存的池 id 列表（诊断用）。 */
  activePoolIds(): string[] {
    return Array.from(this.pools.keys());
  }
}

/** 判断 mysql2 结果是否为 ResultSetHeader（写类语句返回的对象）。 */
function isHeaderLike(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).affectedRows !== 'undefined'
  );
}

/**
 * 把 mysql2 统一返回的 [rowsOrList, fieldsOrList] 归一化为 RawResultSet[]。
 * - 单语句 SELECT：[rows, fields] → 1 个集
 * - 单语句写：[header, undefined] → 1 个集（affectedRows 从 header 读取）
 * - 多语句混合：[rowsList, fieldsList] → N 个集，位置一一对应
 */
function normalizeExecuteResult(res: [unknown, unknown]): RawResultSet[] {
  const [first, second] = res;
  // 多语句：first 是数组且元素为 rows 数组（SELECT）或 header（写类）
  if (Array.isArray(first) && first.length > 0 && (Array.isArray(first[0]) || isHeaderLike(first[0]))) {
    const rowsList = first as unknown[];
    const fieldsList = (Array.isArray(second) ? second : []) as unknown[];
    return rowsList.map((item, i) =>
      Array.isArray(item)
        ? normalizeRawSet(item as QueryRow[], fieldsList[i])
        : normalizeRawSet(item as QueryRow[], fieldsList[i]),
    );
  }
  // 单语句：first 为 rows 数组或 header 对象
  return [normalizeRawSet(first as QueryRow[], second)];
}

/** 归一化单个 mysql2 结果集为 RawResultSet。 */
function normalizeRawSet(rows: QueryRow[], fields: unknown): RawResultSet {
  const fieldArr = Array.isArray(fields) ? (fields as Array<{ name?: string }>) : [];
  const affectedRows =
    (rows as unknown as { affectedRows?: number }).affectedRows ??
    (isHeaderLike(rows) ? (rows as Record<string, unknown>).affectedRows as number : 0) ??
    0;
  return {
    rows: (Array.isArray(rows) ? rows : []) as QueryRow[],
    fields,
    affectedRows,
    isWrite: fieldArr.length === 0 && affectedRows >= 0 && !Array.isArray(rows),
  };
}

/**
 * 错误规范化：把 mysql2 / Node 底层错误映射为友好中文消息。
 * 暴露为独立函数便于单测覆盖各分支。
 */
export function normalizeConnectionError(err: unknown): string {
  if (!err) return '未知连接错误';
  const e = err as { code?: string; errno?: number; message?: string; sqlState?: string };
  const code = e.code ?? '';
  switch (code) {
    case 'ETIMEDOUT':
      return '连接超时：服务器无响应或网络不可达';
    case 'ECONNREFUSED':
      return '连接被拒绝：请检查主机/端口是否正确、MySQL 是否启动';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '无法解析主机名：请检查 host 是否正确';
    case 'ER_ACCESS_DENIED_ERROR':
      return '访问被拒绝：用户名或密码错误';
    case 'ER_DBACCESS_DENIED_ERROR':
      return '无权访问该数据库：请检查账号权限或 database 配置';
    case 'ER_BAD_DB_ERROR':
      return '数据库不存在：请检查 database 名称';
    case 'ER_UNKNOWN_CHARACTER_SET':
      return '不支持的字符集：请更换 charset';
    case 'PROTOCOL_CONNECTION_LOST':
      return '连接已断开：服务器关闭了连接';
    case 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR':
      return '连接发生致命错误，请重新测试连接';
    default:
      return e.message ?? '连接失败';
  }
}
