/**
 * 滚动专项 E2E（阶段 5/6：结果区横向滚动 + 对象浏览器/数据预览滚动稳定性）。
 *
 * 依赖：dist/renderer 构建产物 + Playwright chromium（与 ui-layout-check.mjs 同款缓存路径）。
 * 运行：先 `npm run build`，再 `node tests/e2e/scroll-check.mjs`。
 *
 * 验证点：
 *  1. 20 列查询结果：result-grid-scroll.scrollWidth > clientWidth；scrollLeft 可改变；
 *     表头/筛选/数据体共享同一横向滚动源；底部滚动条存在。
 *  2. 空 rows 但多列：仍有表头和横向滚动能力。
 *  3. 30 列数据预览：横向滚动；3 列 500 行：纵向滚动；表头/筛选/数据不错位。
 *  4. 对象浏览器：20 个数据库/表节点时 db-list 可纵向滚动。
 *  5. 窗口 1024x700 / 900x700 下无内容被裁剪到无法访问。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const rendererDist = join(projectRoot, 'dist', 'renderer');
const require = createRequire(import.meta.url);
let pw; try { pw = await import('playwright'); } catch { pw = require('/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
const chromium2 = pw.chromium ?? pw.default.chromium;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf' };
const server = createServer(async (req,res)=>{ const p=decodeURIComponent(new URL(req.url,'http://x').pathname); const f=join(rendererDist, p==='/'?'index.html':p); try{const d=await readFile(f);res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');} });
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;

/** 生成 20 列表 + 5 行的结果集。 */
function resultSet(cols, rows, index = 0) {
  return {
    index,
    statement: 'SELECT',
    columns: Array.from({ length: cols }, (_, i) => ({ name: `col_${i}_very_long_name_${i}`, type: 'varchar', nullable: false, isPrimary: false, isUnique: false })),
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`)),
    affectedRows: 0,
    truncated: false,
    elapsedMs: 1,
  };
}

/** 生成 N 个数据库，每个带 M 张表（对象浏览器滚动）。 */
function schemaMockN(dbCount, tableCount) {
  return {
    'schema:databases': async () => Array.from({ length: dbCount }, (_, i) => `db_${i}_name`),
    'schema:tables': async () => Array.from({ length: tableCount }, (_, i) => ({ name: `table_${i}_long_name`, type: 'table', isView: false })),
    'schema:columns': async () => [{ name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true }],
  };
}
void schemaMockN;

function mockScript({ execute, overrides = {} } = {}) {
  const qExec = execute
    ? `'query:execute':async()=>({connectionId:'c1',totalElapsedMs:42,truncated:false,hasWrite:false,resultSets:[${JSON.stringify(execute)}]}),`
    : `'query:execute':async()=>({connectionId:'c1',totalElapsedMs:42,truncated:false,hasWrite:false,resultSets:[]}),`;
  // overrides: { key: dataValue } → 'key':async()=>DATA,
  // 对象/数组值必须包括号，否则 async()=>{...} 会被当作函数体块（语法错误）。
  const extra = Object.entries(overrides).map(([k, v]) => `${JSON.stringify(k)}:async()=>(${JSON.stringify(v)}),`).join('');
  return `window.sqlStudio={
'app:ping':async()=>'pong',
'connections:list':async()=>[{id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}],
'connections:get':async()=>({id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}),
'connections:testById':async()=>({ok:true,message:'ok'}),'connections:test':async()=>({ok:true,message:'ok'}),'connections:save':async()=>({}),'connections:remove':async()=>({removed:true}),
'schema:databases':async()=>['testdb'],
'schema:tables':async()=>[{name:'users',type:'table',isView:false}],
'schema:columns':async()=>[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],
'schema:ddl':async()=>({ddl:'CREATE TABLE users (id bigint)'}),
'schema:dataPreview':async()=>({index:0,statement:'SELECT',columns:[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],rows:[['1']],affectedRows:0,truncated:false,elapsedMs:1}),
${qExec}
'query:cancel':async()=>({cancelled:true}),
'script:open':async()=>({filePath:'/x/a.sql',content:'SELECT 1;'}),'script:save':async(a)=>({filePath:a.filePath}),
'export:excel':async()=>({filePath:'/x/a.xlsx',rowCount:1}),'export:csv':async()=>({filePath:'/x/a.csv',rowCount:1}),'export:insert':async()=>({filePath:'/x/a.sql',rowCount:1}),
'history:list':async()=>[],'history:add':async(h)=>({...h,id:1,executedAt:Date.now()}),'history:remove':async()=>({removed:true}),
'favorites:list':async()=>[],'favorites:save':async(f)=>({name:f.name}),'favorites:remove':async()=>({removed:true}),'favorites:open':async()=>({filePath:'/x/f.sql',content:'SELECT 1;'}),'favorites:rename':async(f)=>({name:f.newName}),
'ai:complete':async()=>({text:'',isComplete:true}),'settings:getAiConfig':async()=>null,'settings:setAiConfig':async()=>({saved:true}),'settings:get':async()=>null,'settings:set':async()=>({saved:true}),
'dialog:showSaveDialog':async()=>'/save/script.sql','dialog:showOpenDialog':async()=>'/save/script.sql','shell:showItemInFolder':async()=>({shown:true}),${extra}};` +
  `window.confirm=()=>true;window.alert=()=>{};`;
}

// ── 场景 mock ──
// 场景 A：20 列结果
const mock20 = mockScript({ execute: resultSet(20, 5) });
// 场景 B：20 列 0 行
const mock20Empty = mockScript({ execute: resultSet(20, 0) });
// 场景 C：预览 30 列 / 500 行 / 30列0行
const preview30 = resultSet(30, 100);
const preview500 = {
  index: 0,
  statement: 'SELECT',
  columns: Array.from({ length: 3 }, (_, i) => ({ name: `pcol${i}`, type: 'varchar', nullable: false, isPrimary: false, isUnique: false })),
  rows: Array.from({ length: 500 }, (_, r) => [`row${r}a`, `row${r}b`, `row${r}c`]),
  affectedRows: 0,
  truncated: false,
  elapsedMs: 1,
};
const preview30Empty = resultSet(30, 0);
const mockPreview = (rs) => mockScript({
  execute: rs,
  overrides: {
    'schema:dataPreview': rs,
    'schema:databases': ['db1', 'db2'],
    'schema:tables': [{ name: 't1', type: 'table', isView: false }, { name: 't2', type: 'table', isView: false }],
  },
});
// 场景 D：对象浏览器 20 库 × 3 表
const mockExplorer = mockScript({
  overrides: {
    'schema:databases': Array.from({ length: 20 }, (_, i) => `db_${i}_name`),
    'schema:tables': Array.from({ length: 3 }, (_, i) => ({ name: `table_${i}_long_name`, type: 'table', isView: false })),
  },
});
// 场景 E：很多字段的表（40 字段）
const mockFields = mockScript({
  overrides: {
    'schema:databases': ['db1'],
    'schema:tables': [{ name: 'big_table', type: 'table', isView: false }],
    'schema:columns': Array.from({ length: 40 }, (_, i) => ({ name: `field_${i}_long_name_${i}`, type: 'varchar', nullable: false, isPrimary: false, isUnique: false })),
  },
});

const sizes = [{ w: 1024, h: 700, label: '1024x700' }, { w: 900, h: 700, label: '900x700' }];
const browser = await chromium2.launch({ executablePath: '/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
const results = [];

async function newPage(w, h, script) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.addInitScript(script);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  return page;
}

// 1) 20 列结果横向滚动探针
for (const { w, h, label } of sizes) {
  const page = await newPage(w, h, mock20);
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.type('SELECT * FROM big;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const probe = await page.evaluate(() => {
    const scroll = document.querySelector('.result-grid-scroll');
    const header = document.querySelector('.grid-header');
    const filter = document.querySelector('.grid-filter');
    const body = document.querySelector('.grid-body');
    if (!scroll) return { missing: true };
    const before = scroll.scrollLeft;
    scroll.scrollLeft = 500;
    const after = scroll.scrollLeft;
    return {
      missing: false,
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      canScrollX: scroll.scrollWidth > scroll.clientWidth,
      scrollLeftChanged: before !== after,
      headerInside: !!header && scroll.contains(header),
      filterInside: !!filter && scroll.contains(filter),
      bodyInside: !!body && scroll.contains(body),
      // WebKit 横向滚动条存在（scrollbar-height 由滚动容器拥有）
      hasXScrollbar: scroll.scrollWidth > scroll.clientWidth,
      headerAlign: header ? header.getBoundingClientRect().left : null,
      bodyAlign: body ? body.getBoundingClientRect().left : null,
    };
  });
  results.push({ check: 'result-20col', label, probe });
  await page.close();
}

// 2) 20 列 0 行：仍有表头 + 可横滚
{
  const { w, h, label } = sizes[1];
  const page = await newPage(w, h, mock20Empty);
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.type('SELECT * FROM empty;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const probe = await page.evaluate(() => {
    const scroll = document.querySelector('.result-grid-scroll');
    const header = document.querySelector('.grid-header');
    const zero = document.querySelector('.grid-zero');
    return {
      hasHeader: !!header,
      hasZero: !!zero,
      canScrollX: !!scroll && scroll.scrollWidth > scroll.clientWidth,
      headerCells: header ? header.querySelectorAll('.grid-header-cell').length : 0,
      zeroText: zero ? zero.textContent : '',
    };
  });
  results.push({ check: 'result-20col-0row', label, probe });
  await page.close();
}

// 3) 数据预览：30 列 / 500 行 / 30列0行
for (const [name, rs] of [['preview-30col-100row', preview30], ['preview-3col-500row', preview500], ['preview-30col-0row', preview30Empty]]) {
  const { w, h, label } = sizes[1];
  const page = await newPage(w, h, mockPreview(rs));
  const diag = await page.evaluate(() => ({
    hasSqlStudio: typeof window.sqlStudio === 'object',
    bodyLen: document.body ? document.body.innerHTML.length : -1,
    appRoot: !!document.querySelector('#root, .app, .workspace, .main-area'),
  })).catch(() => ({ hasSqlStudio: false, bodyLen: -1, appRoot: false }));
  const consoleErrs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrs.push('PAGEERROR: ' + String(e).slice(0, 200)));
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  // 展开 db1 → 表 t1 出现 → 点预览按钮
  const dbCount = await page.locator('.db-item').count().catch(() => -1);
  const connTexts = await page.locator('.conn-row-line1').allTextContents().catch(() => []);
  await page.click('.db-item:has-text("db1")', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const tableCount = await page.locator('.table-item').count().catch(() => -1);
  const previewCount = await page.locator('.table-item .preview').count().catch(() => -1);
  const previewBtn = page.locator('.table-item .preview').first();
  await previewBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  const modalCount = await page.locator('.preview-modal').count().catch(() => -1);
  const probe = await page.evaluate(() => {
    const modal = document.querySelector('.preview-modal');
    if (!modal) return { missing: true };
    const scroll = modal.querySelector('.result-grid-scroll');
    const body = modal.querySelector('.grid-body');
    const header = modal.querySelector('.grid-header');
    const before = scroll ? scroll.scrollLeft : 0;
    if (scroll) scroll.scrollLeft = 300;
    const after = scroll ? scroll.scrollLeft : 0;
    return {
      missing: false,
      canScrollX: !!scroll && scroll.scrollWidth > scroll.clientWidth,
      scrollLeftChanged: before !== after,
      bodyScrollable: !!body && body.scrollHeight > body.clientHeight,
      headerCells: header ? header.querySelectorAll('.grid-header-cell').length : 0,
      hasZero: !!modal.querySelector('.grid-zero'),
      headerInModal: !!header,
    };
  });
  results.push({ check: name, label, probe, debug: { dbCount, connTexts, tableCount, previewCount, modalCount, consoleErrs: consoleErrs.slice(0, 6), diag } });
  await page.close();
}

// 4) 对象浏览器：20 库 × 3 表，db-list 可纵向滚动
for (const { w, h, label } of sizes) {
  const page = await newPage(w, h, mockExplorer);
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  // 等待 db-list 渲染出 20 个库
  await page.waitForSelector('.db-item', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(600);
  const probe = await page.evaluate(() => {
    const dbList = document.querySelector('.db-list');
    if (!dbList) return { missing: true };
    const before = dbList.scrollTop;
    dbList.scrollTop = 200;
    const after = dbList.scrollTop;
    return {
      missing: false,
      scrollable: dbList.scrollHeight > dbList.clientHeight,
      scrollTopChanged: before !== after,
      dbCount: dbList.querySelectorAll('.db-item').length,
    };
  });
  results.push({ check: 'explorer-20db', label, probe });
  await page.close();
}

// 5) 表字段导航：40 字段可滚动
{
  const { w, h, label } = sizes[1];
  const page = await newPage(w, h, mockFields);
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.type('SELECT * FROM big_table;');
  // 等待字段列表渲染
  await page.waitForSelector('.table-fields-col', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(800);
  const probe = await page.evaluate(() => {
    const body = document.querySelector('.table-fields-body');
    if (!body) return { missing: true };
    const before = body.scrollTop;
    body.scrollTop = 400;
    const after = body.scrollTop;
    return {
      missing: false,
      fieldCount: body.querySelectorAll('.table-fields-col').length,
      scrollable: body.scrollHeight > body.clientHeight,
      scrollTopChanged: before !== after,
    };
  });
  results.push({ check: 'fields-40', label, probe });
  await page.close();
}

// 6) 整体无横向页面溢出（决策门：内容不被裁剪到无法访问）
for (const { w, h, label } of sizes) {
  const page = await newPage(w, h, mock20);
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.type('SELECT * FROM big;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const ov = await page.evaluate(() => ({ d: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  results.push({ check: 'page-no-overflow', label, overflow: ov.d > ov.c + 2 });
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));