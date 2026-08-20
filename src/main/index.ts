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
import { ConnectionManager, type Mysql2Factory } from './services/connection-manager';
import { FavoritesStore } from './services/favorites-store';
import { registerIpc } from './ipc';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

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

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  // 1. 初始化各服务
  const security = new Security();
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'sql-studio.db');

  const metadataStore = new MetadataStore({
    dbPath,
    security,
  });

  const connectionManager = new ConnectionManager(mysqlFactory);
  const favoritesStore = new FavoritesStore(path.join(userDataPath, 'queries'));

  // 2. 注册全部 IPC handler
  registerIpc(
    {
      connectionManager,
      metadataStore,
      favoritesStore,
    },
    ipcMain,
  );

  // 3. 创建窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});