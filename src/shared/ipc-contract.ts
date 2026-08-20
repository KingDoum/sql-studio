/**
 * IPC channel 常量与请求/响应类型（唯一来源，架构铁律 R5）。
 *
 * - channel 命名规范：`域:动作`（如 `connections:list`）。
 * - 所有 handler 返回值统一为 `IpcResponse<T>`（见 shared/types.ts）。
 * - `ai:complete` 与 `settings:*` 已实装（V2 AI 智能补全）。
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
  ExportCsvRequest,
  ExportResult,
  AiCompletionRequest,
  AiCompletionResponse,
  AiConfig,
  ShowSaveDialogOptions,
  ShowOpenDialogOptions,
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
  'connections:testById': 'connections:testById',

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
  'export:csv': 'export:csv',

  // 历史 / 收藏
  'history:list': 'history:list',
  'history:add': 'history:add',
  'history:remove': 'history:remove',
  'favorites:list': 'favorites:list',
  'favorites:save': 'favorites:save',
  'favorites:remove': 'favorites:remove',
  'favorites:open': 'favorites:open',

  // AI 补全（V2 已实装）
  'ai:complete': 'ai:complete',

  // V2 AI 设置
  'settings:getAiConfig': 'settings:getAiConfig',
  'settings:setAiConfig': 'settings:setAiConfig',

  // 通用设置
  'settings:get': 'settings:get',
  'settings:set': 'settings:set',

  // 原生对话框
  'dialog:showSaveDialog': 'dialog:showSaveDialog',
  'dialog:showOpenDialog': 'dialog:showOpenDialog',
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
  'connections:testById': { id: string };

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
  'export:csv': ExportCsvRequest;

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

  // 通用设置
  'settings:get': { key: string };
  'settings:set': { key: string; value: string };

  // 原生保存对话框（导出/另存为共用）
  'dialog:showSaveDialog': ShowSaveDialogOptions;

  // 原生打开文件对话框
  'dialog:showOpenDialog': ShowOpenDialogOptions;
}

export interface IpcResponseMap {
  'app:ping': string;

  'connections:list': ConnectionSummary[];
  'connections:save': ConnectionSummary;
  'connections:remove': { removed: boolean };
  'connections:test': TestConnectionResult;
  'connections:get': ConnectionSummary;
  'connections:testById': TestConnectionResult;

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
  'export:csv': ExportResult;

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

  // 通用设置
  'settings:get': string | null;
  'settings:set': { saved: boolean };

  // 原生保存对话框：返回文件路径（取消返回 null）
  'dialog:showSaveDialog': string | null;

  // 原生打开文件对话框：返回文件路径（取消返回 null）
  'dialog:showOpenDialog': string | null;
}

/** 便捷类型：某 channel 的请求参数类型。 */
export type IpcRequest<C extends IpcChannel> = IpcRequestMap[C];
/** 便捷类型：某 channel 的响应数据类型（成功分支）。 */
export type IpcData<C extends IpcChannel> = IpcResponseMap[C];
