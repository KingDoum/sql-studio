/**
 * IPC handlers：连接管理 / Schema 浏览 / 查询执行 / 执行历史。
 *
 * 共享两项跨 handler 状态：
 * - SchemaCache 实例缓存（按 connectionId，连接保存/删除时清理对应项）；
 * - 查询取消的 AbortController 映射（queryId = connectionId + clientQueryId）。
 */
import { IPC_CHANNELS } from '@shared/ipc-contract';
import { SchemaCache } from './services/schema-cache';
import { QueryService } from './services/query-service';
import type { ColumnMeta, QueryResult } from '@shared/types';
import { makeExecutor, makeSchemaExecutor, type IpcDeps, type IpcHandle } from './ipc-deps';

/** SchemaCache 实例缓存（按 connectionId）—— 连接保存/删除时清理对应项。 */
const schemaCaches = new Map<string, SchemaCache>();

/** 查询取消：queryId → AbortController。 */
const queryAborters = new Map<string, AbortController>();
let querySeq = 0;

function getSchemaCache(deps: IpcDeps, connectionId: string): SchemaCache {
  let cache = schemaCaches.get(connectionId);
  if (!cache) {
    cache = new SchemaCache(makeSchemaExecutor(deps, connectionId));
    schemaCaches.set(connectionId, cache);
  }
  return cache;
}

/**
 * 给查询结果的列补上来自 SchemaCache 的注释（仅当列带 tableName 且当前库能查到该表）。
 * 不阻塞主流程：查不到就保持无注释。
 */
async function enrichColumnComments(
  deps: IpcDeps,
  result: QueryResult,
  connectionId: string,
  database?: string,
): Promise<void> {
  if (!database) return;
  const cache = getSchemaCache(deps, connectionId);
  for (const rs of result.resultSets) {
    if (!rs.columns?.length) continue;
    const tables = Array.from(new Set(rs.columns.map((c) => c.tableName).filter(Boolean) as string[]));
    if (!tables.length) continue;
    const colsByTable = new Map<string, ColumnMeta[]>();
    for (const t of tables) {
      try {
        colsByTable.set(t, await cache.getColumns(database, t));
      } catch {
        colsByTable.set(t, []);
      }
    }
    rs.columns = rs.columns.map((c) => {
      if (c.comment) return c; // 已有注释不覆盖
      if (!c.tableName) return c;
      const cols = colsByTable.get(c.tableName);
      const meta = cols?.find((x) => x.name === c.name);
      return meta?.comment ? { ...c, comment: meta.comment } : c;
    });
  }
}

export function registerDbHandlers(handle: IpcHandle, deps: IpcDeps): void {
  // ── 连接管理 ──
  handle(IPC_CHANNELS['connections:list'], () => deps.metadataStore.listConnections());
  handle(IPC_CHANNELS['connections:save'], async (arg) => {
    const summary = deps.metadataStore.saveConnection(arg);
    // 保存后关闭旧连接池 + 清理 schema 缓存，让新配置立即生效
    if (arg.id) {
      try { await deps.connectionManager.closePool(arg.id); } catch {}
      schemaCaches.delete(arg.id);
    }
    return summary;
  });
  handle(IPC_CHANNELS['connections:remove'], async (arg) => {
    try { await deps.connectionManager.closePool(arg.id); } catch {}
    schemaCaches.delete(arg.id);
    return { removed: deps.metadataStore.removeConnection(arg.id) };
  });
  handle(IPC_CHANNELS['connections:test'], (arg) => deps.connectionManager.testConnection(arg));
  handle(IPC_CHANNELS['connections:get'], (arg) => {
    const c = deps.metadataStore.getConnection(arg.id);
    if (!c) throw new Error(`连接不存在: ${arg.id}`);
    return c;
  });
  // 测试已保存连接（主进程解密取配置，渲染进程不接触密码，铁律 R6）
  handle(IPC_CHANNELS['connections:testById'], async (arg) => {
    const config = deps.metadataStore.getConnectionConfig(arg.id);
    if (!config) throw new Error(`连接不存在: ${arg.id}`);
    return deps.connectionManager.testConnection({
      name: config.name,
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: config.charset,
    });
  });

  // ── Schema 浏览 ──
  handle(IPC_CHANNELS['schema:databases'], (arg) => {
    const cache = getSchemaCache(deps, arg.connectionId);
    return cache.listDatabases();
  });
  handle(IPC_CHANNELS['schema:tables'], (arg) => {
    const cache = getSchemaCache(deps, arg.connectionId);
    return cache.listTables(arg.database);
  });
  handle(IPC_CHANNELS['schema:columns'], (arg) => {
    const cache = getSchemaCache(deps, arg.connectionId);
    return cache.getColumns(arg.database, arg.table);
  });
  handle(IPC_CHANNELS['schema:ddl'], async (arg) => {
    const cache = getSchemaCache(deps, arg.connectionId);
    const ddl = await cache.getDdl(arg.database, arg.table);
    return { ddl };
  });
  handle(IPC_CHANNELS['schema:dataPreview'], async (arg) => {
    const limit = Math.min(arg.limit ?? 100, 1000);
    // 反引号转义防 SQL 注入
    const esc = (s: string) => s.replace(/`/g, '``');
    const sql = `SELECT * FROM \`${esc(arg.database)}\`.\`${esc(arg.table)}\` LIMIT ${limit}`;
    // 与普通查询共用同一条执行链路（makeExecutor → executeMany → QueryService）。
    // 历史实现是「先手动 executeMany，再用 mock executor 二次包装结果」，
    // 会让语句切分、写操作标记与耗时统计全部失真（sql 传空串）。
    const qs = new QueryService(makeExecutor(deps, arg.connectionId, arg.database));
    const result = await qs.run({ connectionId: arg.connectionId, sql });
    return result.resultSets[0];
  });

  // ── 查询执行 ──
  handle(IPC_CHANNELS['query:execute'], async (arg) => {
    const abortController = new AbortController();
    const queryId = arg.clientQueryId
      ? `${arg.connectionId}:${arg.clientQueryId}`
      : `${arg.connectionId}:${++querySeq}`;
    queryAborters.set(queryId, abortController);
    try {
      const executor = makeExecutor(deps, arg.connectionId, arg.database);
      const qs = new QueryService(executor);
      const result = await qs.run(arg, abortController.signal);
      // 回填列注释（普通查询的 mysql2 fields 不含 Comment，需查 SchemaCache）
      await enrichColumnComments(deps, result, arg.connectionId, arg.database);
      // 自动记录历史
      try {
        const connSummary = deps.metadataStore.getConnection(arg.connectionId);
        deps.metadataStore.addHistory({
          connectionId: arg.connectionId,
          connectionName: connSummary?.name,
          sql: arg.statement ?? arg.sql,
          success: result.resultSets.every((r) => !r.truncated),
          rowCount: result.resultSets.reduce((n, r) => n + r.rows.length, 0),
          elapsedMs: result.totalElapsedMs,
        });
      } catch {
        // 历史记录失败不影响查询结果
      }
      return result;
    } finally {
      queryAborters.delete(queryId);
    }
  });
  handle(IPC_CHANNELS['query:cancel'], (arg) => {
    const aborter = queryAborters.get(`${arg.connectionId}:${arg.queryId}`);
    if (aborter) {
      aborter.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  // ── 执行历史 ──
  handle(IPC_CHANNELS['history:list'], (arg) => deps.metadataStore.listHistory({ connectionId: arg?.connectionId, limit: arg?.limit }));
  handle(IPC_CHANNELS['history:add'], (arg) => deps.metadataStore.addHistory(arg));
  handle(IPC_CHANNELS['history:remove'], (arg) => ({ removed: deps.metadataStore.removeHistory(arg.id) }));
}
