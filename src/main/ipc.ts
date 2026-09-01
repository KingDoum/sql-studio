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
import { CsvExporter } from './services/csv-exporter';
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
  csvExporter?: CsvExporter;
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
function makeExecutor(deps: IpcDeps, connectionId: string, database?: string): (sql: string, signal?: AbortSignal) => Promise<RawResultSet[]> {
  const config = deps.metadataStore.getConnectionConfig(connectionId);
  if (!config) throw new Error(`连接不存在: ${connectionId}`);
  return (sql: string, signal?: AbortSignal) => {
    // 目标库与连接默认库不同时，直接把目标库写入连接配置（临时连接建连即 USE 该库），
    // 避免在 SQL 前拼 `USE db;` —— 那会让 USE 语句成为一个空结果集（用户看到"结果1 恒 0 行"）。
    const effectiveConfig = database && database !== config.database
      ? { ...config, database }
      : config;
    return deps.connectionManager.executeMany(effectiveConfig as ConnectionConfig, sql, signal);
  };
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

  // schema 浏览
  // 缓存 SchemaCache 实例（按 connectionId），避免每次 IPC 调用新建实例
  const schemaCaches = new Map<string, SchemaCache>();
  function getSchemaCache(connectionId: string): SchemaCache {
    let cache = schemaCaches.get(connectionId);
    if (!cache) {
      cache = new SchemaCache(makeSchemaExecutor(deps, connectionId));
      schemaCaches.set(connectionId, cache);
    }
    return cache;
  }

  handle(IPC_CHANNELS['schema:databases'], (arg) => {
    const cache = getSchemaCache(arg.connectionId);
    return cache.listDatabases();
  });
  handle(IPC_CHANNELS['schema:tables'], (arg) => {
    const cache = getSchemaCache(arg.connectionId);
    return cache.listTables(arg.database);
  });
  handle(IPC_CHANNELS['schema:columns'], (arg) => {
    const cache = getSchemaCache(arg.connectionId);
    return cache.getColumns(arg.database, arg.table);
  });
  handle(IPC_CHANNELS['schema:ddl'], async (arg) => {
    const cache = getSchemaCache(arg.connectionId);
    const ddl = await cache.getDdl(arg.database, arg.table);
    return { ddl };
  });
  handle(IPC_CHANNELS['schema:dataPreview'], async (arg) => {
    const limit = Math.min(arg.limit ?? 100, 1000);
    const config = deps.metadataStore.getConnectionConfig(arg.connectionId);
    if (!config) throw new Error(`连接不存在: ${arg.connectionId}`);
    // 反引号转义防 SQL 注入
    const esc = (s: string) => s.replace(/`/g, '``');
    const sets = await deps.connectionManager.executeMany(
      config as ConnectionConfig,
      `SELECT * FROM \`${esc(arg.database)}\`.\`${esc(arg.table)}\` LIMIT ${limit}`,
    );
    const qs = new QueryService((sql) => Promise.resolve(sets));
    const result = await qs.run({ connectionId: arg.connectionId, sql: '' });
    return result.resultSets[0];
  });

  // 查询执行
  // 取消机制：queryId = connectionId + clientQueryId（渲染进程生成）或自增序号；AbortController 映射
  const queryAborters = new Map<string, AbortController>();
  let querySeq = 0;
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
      await enrichColumnComments(result, arg.connectionId, arg.database);
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

  /**
   * 给查询结果的列补上来自 SchemaCache 的注释（仅当列带 tableName 且当前库能查到该表）。
   * 不阻塞主流程：查不到就保持无注释。
   */
  async function enrichColumnComments(
    result: import('@shared/types').QueryResult,
    connectionId: string,
    database?: string,
  ): Promise<void> {
    if (!database) return;
    const cache = getSchemaCache(connectionId);
    for (const rs of result.resultSets) {
      if (!rs.columns?.length) continue;
      const tables = Array.from(new Set(rs.columns.map((c) => c.tableName).filter(Boolean) as string[]));
      if (!tables.length) continue;
      const colsByTable = new Map<string, import('@shared/types').ColumnMeta[]>();
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
  handle(IPC_CHANNELS['query:cancel'], (arg) => {
    const aborter = queryAborters.get(`${arg.connectionId}:${arg.queryId}`);
    if (aborter) {
      aborter.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

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
  handle(IPC_CHANNELS['export:csv'], (arg) => {
    const exporter = deps.csvExporter ?? new CsvExporter();
    return exporter.export(arg).then((n) => ({ filePath: arg.options.filePath, rowCount: n }));
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
  handle(IPC_CHANNELS['favorites:rename'], (arg) => deps.favoritesStore.renameFavorite(arg.name, arg.newName));

  // ── AI 智能补全（V2 实装）──
  handle(IPC_CHANNELS['ai:complete'], async (arg) => {
    const config = deps.metadataStore.getAiConfig();
    if (!config || !config.enabled) throw new Error('AI 补全未启用');
    const service = deps.aiService ?? new AiService();
    return service.complete(arg, config);
  });

  // ── AI 设置（V2，阶段 3：Renderer 只见 AiPublicConfig，不含 apiKey）──
  handle(IPC_CHANNELS['settings:getAiConfig'], () => deps.metadataStore.getAiPublicConfig());
  handle(IPC_CHANNELS['settings:setAiConfig'], (arg) => {
    deps.metadataStore.setAiConfig(arg);
    return { saved: true };
  });

  // ── 通用设置（导出目录等持久化）──
  handle(IPC_CHANNELS['settings:get'], (arg) => deps.metadataStore.getSetting(arg.key));
  handle(IPC_CHANNELS['settings:set'], (arg) => {
    deps.metadataStore.setSetting(arg.key, arg.value);
    return { saved: true };
  });

  // ── 原生保存对话框（Electron dialog，替代 window.prompt）──
  // 动态 require electron 避免测试环境顶层 import 失败
  handle(IPC_CHANNELS['dialog:showSaveDialog'], async (arg) => {
    const electron = require('electron') as typeof import('electron');
    const win = electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0];
    const result = await electron.dialog.showSaveDialog(win, {
      title: arg.title,
      defaultPath: arg.defaultPath,
      filters: arg.filters,
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  // ── 原生打开文件对话框 ──
  handle(IPC_CHANNELS['dialog:showOpenDialog'], async (arg) => {
    const electron = require('electron') as typeof import('electron');
    const win = electron.BrowserWindow.getFocusedWindow() ?? electron.BrowserWindow.getAllWindows()[0];
    const result = await electron.dialog.showOpenDialog(win, {
      title: arg.title,
      defaultPath: arg.defaultPath,
      filters: arg.filters,
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0]!;
  });

  // ── 系统 Shell：在文件管理器中显示文件（导出/另存为定位用）──
  handle(IPC_CHANNELS['shell:showItemInFolder'], (arg) => {
    const electron = require('electron') as typeof import('electron');
    electron.shell.showItemInFolder(arg.path);
    return { shown: true };
  });
}
