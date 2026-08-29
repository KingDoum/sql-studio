/**
 * UI 布局多尺寸验证脚本（S2 验收辅助，Playwright 无头）。
 * 加载构建产物 dist/renderer/index.html，注入 mock window.sqlStudio，
 * 在 1440×900 / 1280×800 / 1024×700 / 900×700 下截图并检测横向溢出。
 * 运行：node tests/e2e/ui-layout-check.mjs
 */
import { createRequire } from 'node:module';

// playwright 未在项目本地安装，回退到 npx 缓存（若存在）
const require = createRequire(import.meta.url);
let pw;
try {
  pw = await import('playwright');
} catch {
  const cache = '/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright';
  pw = require(cache);
}
const chromium2 = pw.chromium ?? pw.default.chromium;
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDist = join(__dirname, '..', '..', 'dist', 'renderer');
const outDir = join(__dirname, '..', '..', 'docs', 'ui-screenshots');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 静态服务器（CSP 需要 http(s) 环境；Monaco worker 走 blob:）
const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = join(rendererDist, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// mock window.sqlStudio（模拟 preload 暴露的 API）
const mockScript = `
  const conn = { id: 'c1', name: '测试数据库', host: '127.0.0.1', port: 3307, user: 'root', charset: 'utf8mb4', database: 'testdb', createdAt: 1, updatedAt: 1 };
  window.sqlStudio = {
    'app:ping': async () => 'pong',
    'connections:list': async () => [conn],
    'connections:get': async () => conn,
    'connections:save': async (i) => ({ ...conn, ...i, id: 'c2' }),
    'connections:remove': async () => ({ removed: true }),
    'connections:test': async () => ({ ok: true, message: '连接成功' }),
    'connections:testById': async () => ({ ok: true, message: 'ok' }),
    'schema:databases': async () => ['testdb', 'information_schema'],
    'schema:tables': async () => [
      { name: 'users', type: 'table', isView: false, comment: '用户表' },
      { name: 'orders', type: 'table', isView: false },
      { name: 'v_active', type: 'view', isView: true },
    ],
    'schema:columns': async () => [
      { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
      { name: 'name', type: 'varchar(64)', nullable: false, isPrimary: false, isUnique: false },
      { name: 'email', type: 'varchar(128)', nullable: true, isPrimary: false, isUnique: false },
    ],
    'schema:ddl': async () => ({ ddl: 'CREATE TABLE users (id bigint primary key)' }),
    'schema:dataPreview': async () => ({ index: 0, statement: 'SELECT', columns: [], rows: [], affectedRows: 0, truncated: false, elapsedMs: 1 }),
    'query:execute': async () => ({
      connectionId: 'c1',
      totalElapsedMs: 42,
      truncated: false,
      hasWrite: false,
      resultSets: [{
        index: 0,
        statement: 'SELECT * FROM users',
        columns: [
          { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
          { name: 'name', type: 'varchar(64)', nullable: false, isPrimary: false, isUnique: false },
          { name: 'email', type: 'varchar(128)', nullable: true, isPrimary: false, isUnique: false },
        ],
        rows: [['1', '张三', 'zhang@example.com'], ['2', '李四', 'li@example.com'], ['3', '王五', null]],
        affectedRows: 0,
        truncated: false,
        elapsedMs: 42,
      }],
    }),
    'query:cancel': async () => ({ cancelled: true }),
    'script:open': async () => ({ filePath: '/x/a.sql', content: 'SELECT 1;' }),
    'script:save': async (a) => ({ filePath: a.filePath }),
    'export:excel': async () => ({ path: '/x/a.xlsx' }),
    'export:csv': async () => ({ path: '/x/a.csv' }),
    'export:insert': async () => ({ path: '/x/a.sql' }),
    'history:list': async () => [],
    'history:add': async (h) => ({ ...h, id: 1, executedAt: Date.now() }),
    'history:remove': async () => ({ removed: true }),
    'favorites:list': async () => [],
    'favorites:save': async (f) => ({ name: f.name }),
    'favorites:remove': async () => ({ removed: true }),
    'favorites:open': async () => ({ filePath: '/x/f.sql', content: 'SELECT 1;' }),
    'favorites:rename': async (f) => ({ name: f.newName }),
    'ai:complete': async () => ({ text: '', isComplete: true }),
    'settings:getAiConfig': async () => null,
    'settings:setAiConfig': async () => ({ saved: true }),
    'settings:get': async () => null,
    'settings:set': async () => ({ saved: true }),
    'dialog:showSaveDialog': async () => '/save/script.sql',
    'dialog:showOpenDialog': async () => '/save/script.sql',
    'shell:showItemInFolder': async () => ({ shown: true }),
  };
  window.confirm = () => true;
  window.alert = () => {};
`;

const sizes = [
  { w: 1440, h: 900, label: '1440x900' },
  { w: 1280, h: 800, label: '1280x800' },
  { w: 1024, h: 700, label: '1024x700' },
  { w: 900, h: 700, label: '900x700' },
];

const browser = await chromium2.launch({
  executablePath: '/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const results = [];
for (const { w, h, label } of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.addInitScript(mockScript);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // 等 Monaco 预热 + 连接测试

  // 检查横向溢出
  const overflow = await page.evaluate(() => ({
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  }));

  // 截图 1：空工作台 + 连接列表
  await page.screenshot({ path: join(outDir, `S2-${label}-empty.png`) });

  // 选中连接 → 展开对象浏览器
  await page.click('text=测试数据库').catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, `S2-${label}-conn.png`) });

  // 新建标签 → 输入 SQL → 执行 → 有结果
  await page.click('text=新建').catch(() => {});
  await page.waitForTimeout(600);
  const overflow2 = await page.evaluate(() => ({
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
  }));
  await page.screenshot({ path: join(outDir, `S2-${label}-editor.png`) });

  const hOverflow = (overflow.docScrollW > overflow.docClientW + 2) || (overflow2.docScrollW > overflow2.docClientW + 2);
  results.push({ label, w, h, hOverflow, detail: overflow, detail2: overflow2 });
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
