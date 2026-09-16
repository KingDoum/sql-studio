/**
 * IPC handlers：脚本文件读写 / 数据导出 / 命名收藏 / 原生对话框 / 系统 Shell。
 */
import { IPC_CHANNELS } from '@shared/ipc-contract';
import { ScriptStore } from './services/script-store';
import { ExcelExporter } from './services/excel-exporter';
import { SqlExporter } from './services/sql-exporter';
import { CsvExporter } from './services/csv-exporter';
import { assertScriptPath, type IpcDeps, type IpcHandle } from './ipc-deps';

export function registerIoHandlers(handle: IpcHandle, deps: IpcDeps): void {
  // ── 脚本文件 ──
  handle(IPC_CHANNELS['script:open'], (arg) => {
    const store = deps.scriptStore ?? new ScriptStore();
    const filePath = assertScriptPath(arg.filePath);
    const content = store.read(filePath);
    // 附带 mtime：Renderer 记录它，保存前对比即可发现「文件被外部编辑器改过」
    return { filePath, content, mtimeMs: store.stat(filePath) ?? undefined };
  });
  handle(IPC_CHANNELS['script:stat'], (arg) => {
    const store = deps.scriptStore ?? new ScriptStore();
    return { mtimeMs: store.stat(assertScriptPath(arg.filePath)) };
  });
  handle(IPC_CHANNELS['script:save'], (arg) => {
    const store = deps.scriptStore ?? new ScriptStore();
    // filePath 必须由 Renderer 经系统保存对话框获得（绝对路径）。
    // 历史实现在缺省时会用「推断的文件名」写文件，实际落到了进程工作目录，已移除。
    const filePath = assertScriptPath(arg.filePath);
    store.write(filePath, arg.content);
    return { filePath };
  });

  // ── 导出 ──
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

  // ── 命名收藏（文件库）──
  handle(IPC_CHANNELS['favorites:list'], () => deps.favoritesStore.listFavorites());
  handle(IPC_CHANNELS['favorites:save'], (arg) => deps.favoritesStore.saveFavorite(arg));
  handle(IPC_CHANNELS['favorites:remove'], (arg) => ({ removed: deps.favoritesStore.removeFavorite(arg.name) }));
  handle(IPC_CHANNELS['favorites:open'], (arg) => deps.favoritesStore.readFavorite(arg.name));
  handle(IPC_CHANNELS['favorites:rename'], (arg) => deps.favoritesStore.renameFavorite(arg.name, arg.newName));

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
