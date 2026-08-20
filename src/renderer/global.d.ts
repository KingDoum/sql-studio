/**
 * 全局类型声明（任务 7）。
 * 暴露 window.sqlStudio 的类型（由 preload 注入），供渲染进程调用主进程能力。
 */
import type { SqlStudioApi } from '@preload/index';

declare global {
  interface Window {
    sqlStudio: SqlStudioApi;
  }
}

export {};
