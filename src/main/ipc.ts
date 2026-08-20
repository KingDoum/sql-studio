/**
 * IPC 路由注册（任务 7 main-ipc-preload）。
 *
 * 注册全部 ipcMain.handle（channel 来自 ipc-contract.ts 单一来源），每个 handler
 * 统一 try/catch 包装为 {ok, data} / {ok:false, error}，避免异常泄漏到渲染进程。
 *
 * 依赖注入：registerIpc(deps, ipcMain)。deps 聚合各 service，由应用入口组装，
 * 便于单测注入 mock。渲染进程只通过 preload 暴露的 window.sqlStudio 调用，
 * 绝不直接持有 ConnectionConfig / password（铁律 R6）。
 */

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc-contract';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '@shared/ipc-contract';
import { ConnectionManager } from './services/connection-manager';
import { MetadataStore } from './services/metadata-store';
import { SchemaCache } from './services/schema-cache';
import { QueryService, type RawResultSet } from './services/query-service';
import { ScriptStore } from './services/script-store';
import { ExcelExporter } from './services/excel-exporter';
import { SqlExporter } from './services/sql-exporter';
import { AiService } from './services/ai-service';
import { FavoritesStore } from './services/favorites-store';
import type { ConnectionConfig, AiConfig } from '@shared/types';

/** 全部依赖（service 实例），由应用入口注入。 */
export interface IpcDeps {
  connectionManager: ConnectionManager;
  metadataStore: MetadataStore;
  favoritesStore: FavoritesStore;
  aiService?: AiService;
  scriptStore?: ScriptStore;
  excelExporter?: ExcelExporter;
  sqlExporter?: SqlExporter;
}

/** 统一异常 → 友好错误响应。 */
function fail(err: unknown): { ok: false; error: string; errorType?: string } {
  const e = err as { message?: string; code?: string };
  const msg = e?.message ?? '未知错误';
  let errorType: string | undefined;
  if (e?.code) errorType = e.code;
  return { ok: false, error: msg, errorType };
}

/**
 * 构造一个针对某连接的 query executor（多结果集）。
 * 渲染进程仅传 connectionId，明文配置由 metadataStore 在主进程解密取出。
 */
function makeExecutor(deps: IpcDeps, connectionId: string): (sql: string) => Promise<RawResultSet[]> {
  const config = deps.metadataStore.getConnectionConfig(connectionId);
  if (!config) throw new Error(`连接不存在: ${connectionId}`);
  return (sql: string) => deps.connectionManager.executeMany(config as ConnectionConfig, sql);
}

function makeSchemaExecutor(deps: IpcDeps, connectionId: string) {
  const config = deps.metadataStore.getConnectionConfig(connectionId);
  if (!config) throw new Error(`连接不存在: ${connectionId}`);
  return (sql: string) =>
    deps.connectionManager.executeMany(config as ConnectionConfig, sql).then((sets) => sets[0]?.rows ?? []);
}

export function registerIpc(deps: IpcDeps, ipcMain: IpcMain): void {
  const handle = <C extends IpcChannel>(
    channel: C,
    fn: (arg: IpcRequestMap[C]) => Promise<IpcResponseMap[C]> | IpcResponseMap[C],
  ) => {
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return { ok: true as const, data: await fn(arg as IpcRequestMap[C]) };
      } catch (err) {
        return fail(err);
      }
    });
  };

  // 应用
  handle(IPC_CHANNELS.ping, () => 'pong');

  // 连接管理
  handle(IPC_CHANNELS['connections:list'], () => deps.metadataStore.listConnections());
  handle(IPC_CHANNELS['connections:save'], (arg) => deps.metadataStore.saveConnection(arg));
  handle(IPC_CHANNELS['connections:remove'], (arg) => {
    deps.connectionManager.closePool(arg.id);
    return { removed: deps.metadataStore.removeConnection(arg.id) };
  });
  handle(IPC_CHANNELS['connections:test'], (arg) => deps.connectionManager.testConnection(arg));
  handle(IPC_CHANNELS['connections:get'], (arg) => {
    const c = deps.metadataStore.getConnection(arg.id);
    if (!c) throw new Error(`连接不存在: ${arg.id}`);
    return c;
  });

  // schema 浏览
  handle(IPC_CHANNELS['schema:databases'], (arg) => {
    const cache = new SchemaCache(makeSchemaExecutor(deps, arg.connectionId));
    return cache.listDatabases();
  });
  handle(IPC_CHANNELS['schema:tables'], (arg) => {
    const cache = new SchemaCache(makeSchemaExecutor(deps, arg.connectionId));
    return cache.listTables(arg.database);
  });
  handle(IPC_CHANNELS['schema:columns'], (arg) => {
    const cache = new SchemaCache(makeSchemaExecutor(deps, arg.connectionId));
    return cache.getColumns(arg.database, arg.table);
  });
  handle(IPC_CHANNELS['schema:ddl'], async (arg) => {
    const cache = new SchemaCache(makeSchemaExecutor(deps, arg.connectionId));
    const ddl = await cache.getDdl(arg.database, arg.table);
    return { ddl };
  });
  handle(IPC_CHANNELS['schema:dataPreview'], async (arg) => {
    const limit = arg.limit ?? 100;
    const config = deps.metadataStore.getConnectionConfig(arg.connectionId);
    if (!config) throw new Error(`连接不存在: ${arg.connectionId}`);
    const sets = await deps.connectionManager.executeMany(
      config as ConnectionConfig,
      `SELECT * FROM \`${arg.database}\`.\`${arg.table}\` LIMIT ${limit}`,
    );
    const qs = new QueryService((sql) => Promise.resolve(sets));
    const result = await qs.run({ connectionId: arg.connectionId, sql: '' });
    return result.resultSets[0];
  });

  // 查询执行
  handle(IPC_CHANNELS['query:execute'], async (arg) => {
    const executor = makeExecutor(deps, arg.connectionId);
    const qs = new QueryService(executor);
    const result = await qs.run(arg);
    // 自动记录历史
    try {
      const connSummary = deps.metadataStore.getConnection(arg.connectionId);
      deps.metadataStore.addHistory({
        connectionId: arg.connectionId,
        connectionName: connSummary?.name,
        sql: arg.statement ?? arg.sql,
        success: !result.resultSets.some((r) => r.truncated) || true,
        rowCount: result.resultSets.reduce((n, r) => n + r.rows.length, 0),
        elapsedMs: result.totalElapsedMs,
      });
    } catch {
      // 历史记录失败不影响查询结果
    }
    return result;
  });
  handle(IPC_CHANNELS['query:cancel'], () => ({ cancelled: true }));

  // 脚本文件
  handle(IPC_CHANNELS['script:open'], (arg) => {
    const store = deps.scriptStore ?? new ScriptStore();
    const content = store.read(arg.filePath);
    return { filePath: arg.filePath, content };
  });
  handle(IPC_CHANNELS['script:save'], (arg) => {
    const store = deps.scriptStore ?? new ScriptStore();
    const filePath =
      arg.filePath ??
      // script-store 默认文件名推断
      (store.constructor as typeof ScriptStore).defaultFileName(arg.content);
    store.write(filePath, arg.content);
    return { filePath };
  });

  // 导出
  handle(IPC_CHANNELS['export:excel'], async (arg) => {
    const exporter = deps.excelExporter ?? new ExcelExporter();
    const n = await exporter.export(arg);
    return { filePath: arg.options.filePath, rowCount: n };
  });
  handle(IPC_CHANNELS['export:insert'], (arg) => {
    const exporter = deps.sqlExporter ?? new SqlExporter();
    const n = exporter.export(arg);
    return { filePath: arg.options.filePath, rowCount: n };
  });

  // 历史
  handle(IPC_CHANNELS['history:list'], (arg) => deps.metadataStore.listHistory({ connectionId: arg?.connectionId, limit: arg?.limit }));
  handle(IPC_CHANNELS['history:add'], (arg) => deps.metadataStore.addHistory(arg));
  handle(IPC_CHANNELS['history:remove'], (arg) => ({ removed: deps.metadataStore.removeHistory(arg.id) }));

  // 收藏（文件库 D1）
  handle(IPC_CHANNELS['favorites:list'], () => deps.favoritesStore.listFavorites());
  handle(IPC_CHANNELS['favorites:save'], (arg) => deps.favoritesStore.saveFavorite(arg));
  handle(IPC_CHANNELS['favorites:remove'], (arg) => ({ removed: deps.favoritesStore.removeFavorite(arg.name) }));
  handle(IPC_CHANNELS['favorites:open'], (arg) => deps.favoritesStore.readFavorite(arg.name));

  // ── AI 智能补全（V2 实装）──
  handle(IPC_CHANNELS['ai:complete'], async (arg) => {
    const config = deps.metadataStore.getAiConfig();
    if (!config || !config.enabled) throw new Error('AI 补全未启用');
    const service = deps.aiService ?? new AiService();
    return service.complete(arg, config);
  });

  // ── AI 设置（V2）──
  handle(IPC_CHANNELS['settings:getAiConfig'], () => deps.metadataStore.getAiConfig());
  handle(IPC_CHANNELS['settings:setAiConfig'], (arg) => {
    deps.metadataStore.setAiConfig(arg);
    return { saved: true };
  });
}
