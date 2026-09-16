/**
 * IPC 共享基础设施（拆分自原单文件 ipc.ts）。
 *
 * 这里只放「与具体 channel 无关」的内容：依赖聚合、handler 注册签名、
 * 统一错误结构，以及被多个域复用的校验/构造工具。
 * 各域 handler 见 `ipc-handlers-*.ts`，组装入口见 `ipc.ts`。
 */
import path from 'node:path';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '@shared/ipc-contract';
import type { ConnectionManager } from './services/connection-manager';
import type { MetadataStore } from './services/metadata-store';
import type { RawResultSet } from './services/query-service';
import type { ScriptStore } from './services/script-store';
import type { ExcelExporter } from './services/excel-exporter';
import type { SqlExporter } from './services/sql-exporter';
import type { CsvExporter } from './services/csv-exporter';
import type { AiService } from './services/ai-service';
import type { FavoritesStore } from './services/favorites-store';
import type { WorkspaceRecoveryStore } from './services/workspace-recovery-store';
import type { PersistentLogService } from './services/persistent-log-service';
import type { Security } from './services/security';
import type { ConnectionConfig } from '@shared/types';

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
  /** 工作区恢复存储（S2 起由 index.ts 注入真实实例）。 */
  workspaceStore?: WorkspaceRecoveryStore;
  /** 持久日志服务（S4 起由 index.ts 注入真实实例）。 */
  logService?: PersistentLogService;
  /** 安全存储（供 Renderer 查询加密可用性，用于「密码为降级存储」提示）。 */
  security?: Security;
}

/**
 * handler 注册签名：由 `registerIpc` 提供的统一包装器。
 * 它把 handler 的返回/异常归一为 `{ok,data}` / `{ok:false,error}`。
 */
export type IpcHandle = <C extends IpcChannel>(
  channel: C,
  fn: (arg: IpcRequestMap[C]) => Promise<IpcResponseMap[C]> | IpcResponseMap[C],
) => void;

/** 统一异常 → 友好错误响应。 */
export function fail(err: unknown): { ok: false; error: string; errorType?: string } {
  const e = err as { message?: string; code?: string };
  const msg = e?.message ?? '未知错误';
  let errorType: string | undefined;
  if (e?.code) errorType = e.code;
  return { ok: false, error: msg, errorType };
}

/**
 * 允许通过 `settings:set` 写入的 key 白名单。
 * Renderer 只能写这些键，避免任意键写入污染配置表（运行时校验，不依赖编译期类型）。
 */
export const ALLOWED_SETTING_KEYS = new Set([
  'theme',
  'debugMode',
  'fontSize',
  'fontFamily',
  'lastScriptDir',
  'lastExportDir',
  'resultPanelHeight',
]);

/**
 * 校验 Renderer 传来的脚本文件路径：非空字符串、绝对路径、不含 NUL。
 * 防止越权写入任意位置，或（历史行为）在缺省时把文件写到进程工作目录。
 */
export function assertScriptPath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('非法文件路径：路径不能为空');
  }
  if (filePath.includes('\0')) {
    throw new Error('非法文件路径：包含 NUL 字符');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`非法文件路径：必须是绝对路径（收到 ${filePath}）`);
  }
  return filePath;
}

/**
 * 构造一个针对某连接的 query executor（多结果集）。
 * 渲染进程仅传 connectionId，明文配置由 metadataStore 在主进程解密取出。
 */
export function makeExecutor(
  deps: IpcDeps,
  connectionId: string,
  database?: string,
): (sql: string, signal?: AbortSignal) => Promise<RawResultSet[]> {
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

/** 构造 schema 查询 executor（执行单条只读 SQL，返回行）。 */
export function makeSchemaExecutor(deps: IpcDeps, connectionId: string) {
  const config = deps.metadataStore.getConnectionConfig(connectionId);
  if (!config) throw new Error(`连接不存在: ${connectionId}`);
  return (sql: string) =>
    deps.connectionManager.executeMany(config as ConnectionConfig, sql).then((sets) => sets[0]?.rows ?? []);
}
