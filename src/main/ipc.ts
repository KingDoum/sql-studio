/**
 * IPC 路由注册（组装入口）。
 *
 * 按域拆分为多个模块（原为单文件 430+ 行）：
 * - `ipc-deps.ts`：依赖聚合 / 统一错误结构 / 共享工具（路径校验、执行器构造）
 * - `ipc-handlers-db.ts`：连接管理 / Schema 浏览 / 查询执行 / 执行历史
 * - `ipc-handlers-io.ts`：脚本文件 / 数据导出 / 命名收藏 / 原生对话框 / 系统 Shell
 * - `ipc-handlers-app.ts`：应用信息 / 安全状态 / AI / 设置 / 工作区 / 持久日志
 *
 * 每个 handler 统一 try/catch 包装为 {ok, data} / {ok:false, error}，避免异常泄漏到渲染进程。
 * channel 来自 `ipc-contract.ts` 单一来源；服务实例由应用入口组装注入（便于单测 mock）。
 * 渲染进程只通过 preload 暴露的 window.sqlStudio 调用，绝不直接持有 ConnectionConfig / password。
 */
import type { IpcMain } from 'electron';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '@shared/ipc-contract';
import { fail, type IpcDeps, type IpcHandle } from './ipc-deps';
import { registerDbHandlers } from './ipc-handlers-db';
import { registerIoHandlers } from './ipc-handlers-io';
import { registerAppHandlers } from './ipc-handlers-app';

export type { IpcDeps } from './ipc-deps';

export function registerIpc(deps: IpcDeps, ipcMain: IpcMain): void {
  const handle: IpcHandle = <C extends IpcChannel>(
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

  registerDbHandlers(handle, deps);
  registerIoHandlers(handle, deps);
  registerAppHandlers(handle, deps);
}
