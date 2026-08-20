/**
 * IPC channel 常量与请求/响应类型（唯一来源，架构铁律 R5）。
 *
 * - channel 命名规范：`域:动作`（如 `connections:list`）。
 * - 所有 handler 返回值统一为 `IpcResponse<T>`（见 shared/types.ts）。
 * - `ai.complete` 为 V2 占位：V1 仅定义不注册 handler。
 * - 主进程任何对外连接对象必须是 `ConnectionSummary`，绝不含 password。
 */

import type {
  ConnectionInput,
  ConnectionSummary,
  TestConnectionResult,
  QueryRequest,
  QueryResult,
  ScriptFileResult,
  ScriptSaveRequest,
  HistoryItem,
  FavoriteItem,
  FavoriteSaveRequest,
  ExportExcelRequest,
  ExportInsertRequest,
  ExportResult,
  AiCompletionRequest,
  AiCompletionResponse,
  AiConfig,
} from './types';

/** channel 常量。新增业务 channel 必须在此登记为唯一来源。 */
export const IPC_CHANNELS = {
  // 应用
  ping: 'app:ping',

  // 连接管理
  'connections:list': 'connections:list',
  'connections:save': 'connections:save',
  'connections:remove': 'connections:remove',
  'connections:test': 'connections:test',
  'connections:get': 'connections:get',

  // schema 浏览
  'schema:databases': 'schema:databases',
  'schema:tables': 'schema:tables',
  'schema:columns': 'schema:columns',
  'schema:ddl': 'schema:ddl',
  'schema:dataPreview': 'schema:dataPreview',

  // 查询执行
  'query:execute': 'query:execute',
  'query:cancel': 'query:cancel',

  // 脚本文件
  'script:open': 'script:open',
  'script:save': 'script:save',

  // 导出
  'export:excel': 'export:excel',
  'export:insert': 'export:insert',

  // 历史 / 收藏
  'history:list': 'history:list',
  'history:add': 'history:add',
  'history:remove': 'history:remove',
  'favorites:list': 'favorites:list',
  'favorites:save': 'favorites:save',
  'favorites:remove': 'favorites:remove',
  'favorites:open': 'favorites:open',

  // AI 补全（V2 占位，V1 不注册）
  'ai:complete': 'ai:complete',

  // V2 AI 设置
  'settings:getAiConfig': 'settings:getAiConfig',
  'settings:setAiConfig': 'settings:setAiConfig',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ─────────────────────────────────────────────────────────────
// 各 channel 的请求（invoke 第二参）与响应（IpcResponse<T>）映射
// ─────────────────────────────────────────────────────────────

export interface IpcRequestMap {
  'app:ping': void;

  'connections:list': void;
  'connections:save': ConnectionInput & { id?: string };
  'connections:remove': { id: string };
  'connections:test': ConnectionInput;
  'connections:get': { id: string };

  'schema:databases': { connectionId: string };
  'schema:tables': { connectionId: string; database: string };
  'schema:columns': { connectionId: string; database: string; table: string };
  'schema:ddl': { connectionId: string; database: string; table: string };
  'schema:dataPreview': { connectionId: string; database: string; table: string; limit?: number };

  'query:execute': QueryRequest;
  'query:cancel': { connectionId: string; queryId: string };

  'script:open': { filePath: string };
  'script:save': ScriptSaveRequest;

  'export:excel': ExportExcelRequest;
  'export:insert': ExportInsertRequest;

  'history:list': { connectionId?: string; limit?: number };
  'history:add': Omit<HistoryItem, 'id' | 'executedAt'>;
  'history:remove': { id: string };
  'favorites:list': void;
  'favorites:save': FavoriteSaveRequest;
  'favorites:remove': { name: string };
  'favorites:open': { name: string };

  'ai:complete': AiCompletionRequest;

  // V2 AI 设置
  'settings:getAiConfig': void;
  'settings:setAiConfig': AiConfig;
}

export interface IpcResponseMap {
  'app:ping': string;

  'connections:list': ConnectionSummary[];
  'connections:save': ConnectionSummary;
  'connections:remove': { removed: boolean };
  'connections:test': TestConnectionResult;
  'connections:get': ConnectionSummary;

  'schema:databases': string[];
  'schema:tables': import('./types').TableMeta[];
  'schema:columns': import('./types').ColumnMeta[];
  'schema:ddl': { ddl: string };
  'schema:dataPreview': import('./types').QueryResultSet;

  'query:execute': QueryResult;
  'query:cancel': { cancelled: boolean };

  'script:open': ScriptFileResult;
  'script:save': { filePath: string };

  'export:excel': ExportResult;
  'export:insert': ExportResult;

  'history:list': HistoryItem[];
  'history:add': HistoryItem;
  'history:remove': { removed: boolean };
  'favorites:list': FavoriteItem[];
  'favorites:save': FavoriteItem;
  'favorites:remove': { removed: boolean };
  'favorites:open': import('./types').ScriptFileResult;

  'ai:complete': AiCompletionResponse;

  // V2 AI 设置
  'settings:getAiConfig': AiConfig | null;
  'settings:setAiConfig': { saved: boolean };
}

/** 便捷类型：某 channel 的请求参数类型。 */
export type IpcRequest<C extends IpcChannel> = IpcRequestMap[C];
/** 便捷类型：某 channel 的响应数据类型（成功分支）。 */
export type IpcData<C extends IpcChannel> = IpcResponseMap[C];
