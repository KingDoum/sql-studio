/**
 * Preload 脚本（任务 7 main-ipc-preload）。
 *
 * 通过 contextBridge 暴露 window.sqlStudio —— 渲染进程唯一访问主进程能力的入口。
 * 所有方法签名与 ipc-contract.ts 的 IpcRequestMap / IpcResponseMap 严格一致（铁律 R5）。
 * 渲染进程拿到的连接对象永远是 ConnectionSummary（无 password，铁律 R6）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc-contract';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '@shared/ipc-contract';
import type { IpcResponse } from '@shared/types';

/**
 * 预加载解包：主进程 handler 统一返回 {ok,data}|{ok:false,error}（铁律：统一错误结构），
 * 这里解包为「裸 data resolve / 失败 reject」，使渲染进程可用 await x() 直线调用，
 * 与 App.tsx 等既有的裸返回值用法一致（如 ping() 返回 string）。
 */
type Api = {
  [C in IpcChannel]: IpcRequestMap[C] extends void
    ? () => Promise<IpcResponseMap[C]>
    : (arg: IpcRequestMap[C]) => Promise<IpcResponseMap[C]>;
};

function invokeUnwrapped<T>(channel: string, arg?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, arg).then((res: IpcResponse<T>) => {
    if (res && res.ok === false) {
      throw new Error(res.error);
    }
    return (res as { ok: true; data: T }).data;
  });
}

function buildApi(): Api {
  const api = {} as Api;
  const channels = Object.values(IPC_CHANNELS) as IpcChannel[];
  channels.forEach((channel) => {
    // ai:complete 为 V2 占位，V1 也暴露（返回未实现），保持契约完整
    (api as Record<string, unknown>)[channel] = (arg?: unknown) =>
      invokeUnwrapped(channel, arg);
  });
  return api;
}

const sqlStudio = buildApi();

contextBridge.exposeInMainWorld('sqlStudio', sqlStudio);

export type SqlStudioApi = Api;
