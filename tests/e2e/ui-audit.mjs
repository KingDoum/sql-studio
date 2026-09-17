/**
 * UI 审计截图脚本（设计评审用）。
 *
 * 与其它 e2e 脚本同套路：把 dist/renderer 起成静态站，在 Chromium 中注入 window.sqlStudio mock，
 * 用**贴近真实生产库的假数据**渲染界面，逐主题出图，便于对比改造前后。
 *
 * 用法：
 *   npm run build && node tests/e2e/ui-audit.mjs
 * 可选环境变量：
 *   PW_CHROMIUM=<chromium 可执行文件路径>   指定浏览器（CI 用；本地不填走 playwright 默认）
 *   AUDIT_OUT=<输出目录>                     默认 docs/ui-screenshots/audit
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = process.cwd();
const rendererDist = join(root, 'dist', 'renderer');
const outDir = process.env.AUDIT_OUT ?? join(root, 'docs', 'ui-screenshots', 'audit');

const require = createRequire(import.meta.url);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = require('playwright');
}
const chromium = pw.chromium ?? pw.default.chromium;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = join(rendererDist, p === '/' ? 'index.html' : p);
  try {
    const d = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(d);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

await mkdir(outDir, { recursive: true });

/** 假连接：贴近用户真实生产环境。 */
const CONNECTIONS = [
  {
    id: 'c1',
    name: '生产库 · ads_yewu',
    host: 'mysql-prod.internal.example.com',
    port: 3306,
    user: 'demo_reader',
    charset: 'utf8mb4',
    database: 'ads_yewu',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'c2',
    name: '生产库 · ods_yewu',
    host: 'mysql-prod.internal.example.com',
    port: 3306,
    user: 'demo_reader',
    charset: 'utf8mb4',
    database: 'ods_yewu',
    createdAt: 2,
    updatedAt: 2,
  },
  {
    id: 'c3',
    name: '报表库 · finedb',
    host: '10.0.0.5',
    port: 3306,
    user: 'readonly',
    charset: 'utf8mb4',
    database: 'finedb',
    createdAt: 3,
    updatedAt: 3,
  },
];

/**
 * 注入 window.sqlStudio mock。
 * 该函数会被序列化后在页面上下文执行，**不能引用外部作用域变量**，只能读 opts。
 * 用 Proxy 兜底：未显式定义的通道返回 {}，避免漏 mock 导致启动即报错。
 */
function installMock(opts) {
  const stores = ['SZ-天启优选', 'NJ-恒星跨境', 'GZ-云图科技', 'SZ-海豚出海', 'NJ-北纬数据'];
  const countries = ['US', 'DE', 'GB', 'JP', 'FR'];

  const pad = (n) => String(n).padStart(2, '0');
  const rows = Array.from({ length: opts.rowCount ?? 400 }, (_, i) => {
    const day = ((i * 3) % 28) + 1;
    return [
      57310298 - i * 137,
      '2026-09-' + pad(day),
      'A' + (1032 + (i % 47)) + 'K9',
      stores[i % stores.length],
      countries[i % countries.length],
      'B0' + (7 + (i % 9)) + 'XKQ' + (100 + i),
      12 + ((i * 7) % 480),
      (9.99 + (i % 30)).toFixed(2),
      (1234.56 + i * 731.44).toFixed(2),
      new Uint8Array([i % 2 === 0 ? 1 : 0]),
      JSON.stringify({ channel: i % 2 ? 'amazon' : 'shopify', level: (i % 3) + 1 }),
      i % 5 === 0 ? null : '批次-' + (20260900 + i),
      '2026-09-' + pad(day) + ' 0' + (i % 9) + ':' + pad(i % 60) + ':12',
    ];
  });

  const columns = [
    { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true, comment: '自增主键' },
    { name: 'event_date', type: 'date', nullable: false, isPrimary: false, isUnique: false, comment: '事件日期' },
    { name: 'sid', type: 'varchar', nullable: false, isPrimary: false, isUnique: false, comment: '店铺ID' },
    { name: 'store_name', type: 'varchar', nullable: true, isPrimary: false, isUnique: false, comment: '店铺名称' },
    { name: 'country', type: 'varchar', nullable: true, isPrimary: false, isUnique: false, comment: '国家代码' },
    { name: 'asin', type: 'varchar', nullable: true, isPrimary: false, isUnique: false, comment: '' },
    { name: 'order_count', type: 'int', nullable: true, isPrimary: false, isUnique: false, comment: '订单数' },
    { name: 'unit_price', type: 'decimal', nullable: true, isPrimary: false, isUnique: false, comment: '单价' },
    { name: 'total_amount', type: 'decimal', nullable: true, isPrimary: false, isUnique: false, comment: '总金额' },
    { name: 'is_active', type: 'bit', nullable: true, isPrimary: false, isUnique: false, comment: '是否有效' },
    { name: 'tags', type: 'json', nullable: true, isPrimary: false, isUnique: false, comment: '' },
    { name: 'remark', type: 'varchar', nullable: true, isPrimary: false, isUnique: false, comment: '备注' },
    { name: 'updated_at', type: 'datetime', nullable: true, isPrimary: false, isUnique: false, comment: '' },
  ];

  const resultSet = {
    index: 0,
    statement: 'SELECT id, event_date, sid, store_name, country, asin, order_count, unit_price, total_amount, is_active, tags, remark, updated_at FROM ads_ads_daily_report ORDER BY event_date DESC',
    columns,
    rows,
    affectedRows: 0,
    truncated: false,
    elapsedMs: 412,
  };

  const queryResult = {
    connectionId: 'c1',
    totalElapsedMs: 412,
    truncated: false,
    hasWrite: false,
    resultSets: [resultSet],
  };

  const databases = ['ads_yewu', 'ods_yewu', 'finedb', 'information_schema'];
  const tables = [
    { name: 'ads_ads_daily_report', type: 'table', isView: false, comment: '广告日报' },
    { name: 'ads_exchange_rates', type: 'table', isView: false, comment: '汇率' },
    { name: 'ads_fee_deduction', type: 'table', isView: false, comment: '费用扣减' },
    { name: 'ads_inventory_daily_report', type: 'table', isView: false, comment: '库存日报' },
    { name: 'ads_listing_full_data', type: 'table', isView: false, comment: 'Listing 全量' },
    { name: 'ads_order_fulfillment', type: 'table', isView: false, comment: '' },
    { name: 'ads_profit_daily', type: 'table', isView: false, comment: '利润日报' },
    { name: 'v_ads_summary', type: 'view', isView: true, comment: '汇总视图' },
  ];

  const handlers = {
    'app:ping': async () => 'pong',
    'app:securityStatus': async () => ({ safeStorageAvailable: true, degraded: false }),

    'connections:list': async () => opts.connections,
    'connections:get': async (a) => opts.connections.find((c) => c.id === a.id) ?? null,
    'connections:testById': async () => ({ ok: true, message: '连接成功' }),
    'connections:test': async () => ({ ok: true, message: '连接成功' }),
    'connections:save': async () => ({}),
    'connections:remove': async () => ({ removed: true }),

    'schema:databases': async () => databases,
    'schema:tables': async () => tables,
    'schema:columns': async () => columns.slice(0, 5),
    'schema:ddl': async () => ({
      ddl: 'CREATE TABLE `ads_ads_daily_report` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n)',
    }),
    'schema:dataPreview': async () => resultSet,

    'query:execute': async () => queryResult,
    'query:cancel': async () => ({ cancelled: true }),

    'script:open': async () => ({ filePath: 'ads_daily_report.sql', content: '' }),
    'script:save': async (a) => ({ filePath: a.filePath }),
    'script:stat': async () => ({ exists: true, mtimeMs: Date.now() }),

    'export:excel': async () => ({ filePath: 'A:/x.xlsx', rowCount: rows.length }),
    'export:insert': async () => ({ filePath: 'A:/x.sql', rowCount: rows.length }),
    'export:csv': async () => ({ filePath: 'A:/x.csv', rowCount: rows.length }),

    'history:list': async () => [
      {
        id: 'h1',
        connectionId: 'c1',
        database: 'ads_yewu',
        sql: 'SELECT COUNT(*) FROM ads_ads_daily_report',
        success: true,
        elapsedMs: 128,
        rowCount: 1,
        executedAt: Date.now() - 60_000,
      },
      {
        id: 'h2',
        connectionId: 'c1',
        database: 'ads_yewu',
        sql: 'SELECT * FROM ads_profit_daily LIMIT 100',
        success: true,
        elapsedMs: 246,
        rowCount: 100,
        executedAt: Date.now() - 300_000,
      },
    ],
    'history:add': async () => ({}),
    'history:remove': async () => ({ removed: true }),

    'favorites:list': async () => [
      { name: '广告日报', filePath: 'A:/sql/ads_daily.sql', createdAt: 1, updatedAt: 1 },
      { name: '利润口径核对', filePath: 'A:/sql/profit.sql', createdAt: 2, updatedAt: 2 },
    ],
    'favorites:save': async () => ({}),
    'favorites:remove': async () => ({ removed: true }),
    'favorites:open': async () => ({ filePath: 'A:/sql/ads_daily.sql', content: 'SELECT 1;' }),
    'favorites:rename': async () => ({}),

    'ai:complete': async () => ({ text: '', isComplete: true }),
    'settings:getAiConfig': async () => null,
    'settings:setAiConfig': async () => ({ saved: true }),

    'settings:get': async (a) => {
      let v = null;
      if (a.key === 'theme') v = opts.theme;
      else if (a.key === 'debugMode') v = '0';
      else if (a.key === 'fontSize') v = '12';
      else if (a.key === 'fontFamily') v = 'jetbrains';
      console.log('[MOCK] settings:get ' + a.key + ' -> ' + String(v));
      return v;
    },
    'settings:set': async () => ({ saved: true }),

    'dialog:showSaveDialog': async () => 'A:/sql/x.sql',
    'dialog:showOpenDialog': async () => 'A:/sql/x.sql',
    'shell:showItemInFolder': async () => ({ shown: true }),

    'workspace:load': async () => null,
    'workspace:save': async () => ({ saved: true }),
    'workspace:clear': async () => ({ cleared: true }),

    'logs:append': async () => ({ appended: 1 }),
    'logs:read': async () => ({ text: '', lines: [] }),
    'logs:clear': async () => ({ cleared: true }),
  };

  window.sqlStudio = new Proxy(handlers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => ({});
    },
  });
  window.confirm = () => true;
  window.alert = () => {};
}

const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const browser = await chromium.launch(launchOpts);
const shots = [];

async function openPage(theme, over = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[MOCK]')) console.log('  ' + t);
  });
  await page.addInitScript(installMock, { theme, connections: CONNECTIONS, ...over });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // 诊断：各主要区域的真实背景色（核对主题是否逐区域生效）
  await diagnose(page, `after-load(${theme})`);
  return page;
}

async function shot(page, name) {
  await page.screenshot({ path: join(outDir, name) });
  shots.push(name);
  console.log('  shot ->', name);
}

/** 打印各主要区域的真实背景色（用于核对主题是否逐区域生效）。 */
async function diagnose(page, label = '') {
  const diag = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    const sels = [
      '.app-shell',
      '.sidebar',
      '.top-bar',
      '.main-area',
      '.monaco-editor',
      '.monaco-editor .view-lines',
      '.result-panel',
      '.result-grid-wrap',
      '.grid-header',
      '.grid-row',
      '.grid-body',
      '.status-bar',
    ];
    const out = {};
    for (const s of sels) out[s] = pick(s);
    return { applied: document.documentElement.dataset.theme ?? '(未设置)', out };
  });
  console.log(`  [diag${label ? ' ' + label : ''}] 实际 data-theme=${diag.applied}`);
  for (const [k, v] of Object.entries(diag.out)) {
    if (v !== null) console.log(`         ${k} = ${v}`);
  }
  // Monaco 实际 token 颜色 + 是否存在错误波浪线（用于核对语法着色是否被破坏）
  const mono = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.monaco-editor .view-line span[class*="mtk"]')].slice(0, 8);
    return {
      tokens: spans.map(
        (el) => `${el.className.replace(/mtk/, '')}=${getComputedStyle(el).color} "${(el.textContent ?? '').slice(0, 14)}"`,
      ),
      squiggles: document.querySelectorAll('.monaco-editor .squiggly-error, .monaco-editor .squiggly-warning').length,
      lineColor: (() => {
        const l = document.querySelector('.monaco-editor .view-line');
        return l ? getComputedStyle(l).color : null;
      })(),
    };
  });
  if (mono.tokens.length) console.log('         tokens: ' + mono.tokens.join(' | '));
  console.log(`         squiggles=${mono.squiggles} lineColor=${mono.lineColor}`);
}

async function selectConnectionAndRun(page, sql) {
  await page.click('text=生产库 · ads_yewu');
  await page.waitForTimeout(500);
  await page.getByTitle('新建脚本').click();
  await page.waitForTimeout(800);
  await page.locator('.monaco-editor textarea').first().click().catch(() => {});
  await page.keyboard.type(sql);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1500);
}

/** 1. 三主题主工作区（连接 + 编辑器 + 结果网格） */
for (const theme of ['dark', 'light', 'titanium']) {
  const page = await openPage(theme);
  try {
    await selectConnectionAndRun(page, 'SELECT * FROM ads_ads_daily_report ORDER BY event_date DESC;');
    await diagnose(page);
    await shot(page, `main-${theme}.png`);
  } catch (e) {
    console.error(`main-${theme} 失败:`, e.message);
  } finally {
    await page.close();
  }
}

/** 2. 空态（无连接） */
try {
  const page = await openPage('dark', { connections: [] });
  await shot(page, 'empty-dark.png');
  await page.close();
} catch (e) {
  console.error('empty 失败:', e.message);
}

/** 3. 新建连接弹窗 */
try {
  const page = await openPage('dark');
  await page.getByTitle('新建连接').click();
  await page.waitForTimeout(700);
  await shot(page, 'modal-new-connection-dark.png');
  await page.close();
} catch (e) {
  console.error('modal 失败:', e.message);
}

/** 4. 外观面板（主题与字体） */
try {
  const page = await openPage('dark');
  await page.getByTitle('外观（主题与字体）').click();
  await page.waitForTimeout(700);
  await shot(page, 'panel-appearance-dark.png');
  await page.close();
} catch (e) {
  console.error('appearance 失败:', e.message);
}

/** 5. 快捷键/标题栏右侧 4 个图标所在的历史面板 */
try {
  const page = await openPage('dark');
  await page.getByTitle('执行历史').click();
  await page.waitForTimeout(700);
  await shot(page, 'panel-history-dark.png');
  await page.close();
} catch (e) {
  console.error('history 失败:', e.message);
}

/** 6. 对象浏览器展开 + 数据预览 */
try {
  const page = await openPage('dark');
  await page.click('text=生产库 · ads_yewu');
  await page.waitForTimeout(600);
  await page.click('text=ads_yewu');
  await page.waitForTimeout(700);
  await shot(page, 'explorer-expanded-dark.png');
  await page.close();
} catch (e) {
  console.error('explorer 失败:', e.message);
}

console.log(`\n共 ${shots.length} 张 -> ${outDir}`);
await browser.close();
server.close();
