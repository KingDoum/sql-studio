/**
 * 主进程入口。
 *
 * 启动时序：
 *   1. app.whenReady() → 初始化所有服务（Security / MetadataStore / ConnectionManager / FavoritesStore）
 *   2. registerIpc() → 注册全部 27 个 IPC handler
 *   3. createWindow() → 创建 Electron 窗口，加载 preload + 渲染进程
 */
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { Security } from './services/security';
import { MetadataStore } from './services/metadata-store';
import { WorkspaceRecoveryStore } from './services/workspace-recovery-store';
import { PersistentLogService } from './services/persistent-log-service';
import { ConnectionManager, type Mysql2Factory } from './services/connection-manager';
import { FavoritesStore } from './services/favorites-store';
import { ScriptStore } from './services/script-store';
import { ExcelExporter } from './services/excel-exporter';
import { SqlExporter } from './services/sql-exporter';
import { CsvExporter } from './services/csv-exporter';
import { AiService } from './services/ai-service';
import { registerIpc } from './ipc';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
// 模块级引用，使 before-quit 等事件可访问
let connectionManager: ConnectionManager;
// 持久日志服务（尽早初始化，覆盖 Main 崩溃路径，方案 §12.3）
let logService: PersistentLogService | null = null;

/** mysql2 真实工厂（注入 ConnectionManager）。 */
const mysqlFactory: Mysql2Factory = {
  createPool: (config) => mysql.createPool(config) as never,
  createConnection: async (config) => {
    const conn = await mysql.createConnection(config);
    (conn as { release?: () => void }).release = () => void 0;
    return conn as never;
  },
};

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#16171F',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // BrowserWindow/webContents 生命周期日志（方案 §12.3/§12.13）
  const wc = win.webContents;
  wc.on('render-process-gone', (_e, details) => {
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'main',
        event: 'webContents.render-process-gone',
        message: `Renderer 崩溃 reason=${details.reason} exitCode=${details.exitCode}`,
      }],
      flush: true,
    });
  });
  wc.on('unresponsive', () => {
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'main',
        event: 'webContents.unresponsive',
        message: 'Renderer 无响应',
      }],
      flush: true,
    });
  });
  wc.on('responsive', () => {
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'warn',
        source: 'main',
        event: 'webContents.responsive',
        message: 'Renderer 恢复响应',
      }],
      flush: true,
    });
  });
  wc.on('did-fail-load', ((_e: Electron.Event, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'main',
        event: 'webContents.did-fail-load',
        message: `加载失败 errorCode=${errorCode} description=${errorDescription} isMainFrame=${isMainFrame}`,
        // URL 摘要（脱敏 query）
        context: { url: validatedURL ? validatedURL.split('?')[0] : undefined },
      }],
      flush: true,
    });
  }) as never);

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  // 0. 尽早初始化持久日志（覆盖后续所有启动/初始化日志，方案 §12.3）
  const userDataPath = app.getPath('userData');
  logService = new PersistentLogService({ logDir: path.join(userDataPath, 'logs') });
  logService.append({
    entries: [{
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'main',
      event: 'app.starting',
      message: 'SQL Studio 启动',
    }],
    flush: true,
  });

  // 1. 初始化各服务
  const security = new Security();
  const dbPath = path.join(userDataPath, 'sql-studio.db');

  const metadataStore = new MetadataStore({
    dbPath,
    security,
  });
  logService.append({
    entries: [{
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'main',
      event: 'db.ready',
      message: `数据库就绪 schema_version=${metadataStore.getVersion()}`,
    }],
    flush: false,
  });

  // 工作区恢复存储：复用 MetadataStore 的同一 SQLite 连接（方案 §8.1）
  const workspaceStore = new WorkspaceRecoveryStore(metadataStore.getSharedDatabase());

  connectionManager = new ConnectionManager(mysqlFactory);
  const favoritesStore = new FavoritesStore(path.join(userDataPath, 'queries'));

  // 无状态服务统一在此创建，避免 IPC handler 内每次调用重复 new
  const scriptStore = new ScriptStore();
  const excelExporter = new ExcelExporter();
  const sqlExporter = new SqlExporter();
  const csvExporter = new CsvExporter();
  const aiService = new AiService();

  // 2. 注册全部 IPC handler
  registerIpc(
    {
      connectionManager,
      metadataStore,
      favoritesStore,
      scriptStore,
      excelExporter,
      sqlExporter,
      csvExporter,
      aiService,
      workspaceStore,
      logService,
    },
    ipcMain,
  );

  // 3. 创建窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ── Main 崩溃与生命周期日志（方案 §12.3/§12.13）──
// 在初始化早期注册：uncaughtException / unhandledRejection（尽力落盘、不泄密）
process.on('uncaughtException', (err) => {
  try {
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'main',
        event: 'process.uncaughtException',
        message: err?.message ?? String(err),
        context: { stack: err?.stack ? String(err.stack).slice(0, 2000) : undefined },
      }],
      flush: true,
    });
  } catch {
    // 日志失败不阻断
  }
  // 不吞异常：交给 Electron 默认处理（避免静默崩溃）
});

process.on('unhandledRejection', (reason) => {
  try {
    const r = reason as { message?: string; stack?: string } | undefined;
    logService?.append({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'main',
        event: 'process.unhandledRejection',
        message: r?.message ?? String(reason),
        context: { stack: r?.stack ? String(r.stack).slice(0, 2000) : undefined },
      }],
      flush: true,
    });
  } catch {
    // 忽略
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时序：will-quit 支持 preventDefault + 异步等待，确保 closeAll() 完成后再真正退出。
// 用标志位防重入（await 期间的再次 quit 触发 will-quit 时直接放行）。
let isCleaningUp = false;
app.on('will-quit', (event) => {
  if (isCleaningUp) return;
  event.preventDefault();
  isCleaningUp = true;
  logService?.append({
    entries: [{
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'main',
      event: 'app.quitting',
      message: 'SQL Studio 退出',
    }],
    flush: true,
  });
  const closeAllPromise = (connectionManager?.closeAll() ?? Promise.resolve()).catch(() => {
    // 关闭连接池失败不影响退出
  });
  const finish = () => {
    logService?.flush();
    app.quit();
  };
  // 超时兜底：即使某连接池 end() 挂起，也保证应用能退出
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  Promise.race([closeAllPromise, timeout]).finally(finish);
});
