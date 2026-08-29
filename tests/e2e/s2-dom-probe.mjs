/**
 * S2 关键元素 DOM 探测：确认顶部应用栏/状态栏/连接状态真实渲染。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDist = join(__dirname, '..', '..', 'dist', 'renderer');
const require = createRequire(import.meta.url);
let pw;
try { pw = await import('playwright'); } catch { pw = require('/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
const chromium2 = pw.chromium ?? pw.default.chromium;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = join(rendererDist, urlPath === '/' ? 'index.html' : urlPath);
  try { const data = await readFile(filePath); res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const mockScript = `window.sqlStudio = {
  'app:ping': async () => 'pong',
  'connections:list': async () => [{ id: 'c1', name: '测试数据库', host: '127.0.0.1', port: 3307, user: 'root', charset: 'utf8mb4', database: 'testdb', createdAt: 1, updatedAt: 1 }],
  'connections:get': async () => ({ id: 'c1', name: '测试数据库', host: '127.0.0.1', port: 3307, user: 'root', charset: 'utf8mb4', database: 'testdb', createdAt: 1, updatedAt: 1 }),
  'connections:testById': async () => ({ ok: true, message: 'ok' }),
  'connections:test': async () => ({ ok: true, message: 'ok' }),
  'connections:save': async () => ({}),
  'connections:remove': async () => ({ removed: true }),
  'schema:databases': async () => ['testdb'],
  'schema:tables': async () => [{ name: 'users', type: 'table', isView: false }],
  'schema:columns': async () => [{ name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true }],
  'schema:ddl': async () => ({ ddl: 'CREATE' }),
  'schema:dataPreview': async () => ({ index: 0, statement: 'S', columns: [], rows: [], affectedRows: 0, truncated: false, elapsedMs: 1 }),
  'query:execute': async () => ({ connectionId: 'c1', totalElapsedMs: 42, truncated: false, hasWrite: false, resultSets: [] }),
  'query:cancel': async () => ({ cancelled: true }),
  'script:open': async () => ({ filePath: '/x/a.sql', content: 'SELECT 1;' }),
  'script:save': async (a) => ({ filePath: a.filePath }),
  'history:list': async () => [], 'history:remove': async () => ({ removed: true }),
  'favorites:list': async () => [], 'favorites:remove': async () => ({ removed: true }), 'favorites:open': async () => ({}),
  'settings:get': async () => null, 'settings:set': async () => ({ saved: true }),
  'settings:getAiConfig': async () => null, 'settings:setAiConfig': async () => ({ saved: true }),
  'ai:complete': async () => ({ text: '', isComplete: true }),
  'dialog:showOpenDialog': async () => '/x/a.sql', 'dialog:showSaveDialog': async () => '/x/a.sql',
  'shell:showItemInFolder': async () => ({ shown: true }),
};
window.confirm = () => true; window.alert = () => {};`;

const browser = await chromium2.launch({ executablePath: '/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(mockScript);
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const result = await page.evaluate(() => {
  const has = (sel) => document.querySelectorAll(sel).length;
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  return {
    topBar: has('.top-bar'),
    topBarTitle: text('.top-bar-title'),
    topBarConnName: text('.top-bar-conn-name'),
    topBarConnMeta: text('.top-bar-conn-meta'),
    topBarConnState: text('.top-bar-conn-state'),
    topBarIcons: has('.top-bar-icon-btn'),
    appBody: has('.app-body'),
    sidebar: has('.sidebar'),
    mainArea: has('.main-area'),
    statusBar: has('.status-bar'),
    statusText: text('.status-bar'),
    connList: has('.conn-list li'),
    connStatusDot: has('.conn-status-ok'),
    // 顶部应用栏存在但 sidebar 不再有 sidebar-header
    oldSidebarHeader: has('.sidebar-header'),
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
