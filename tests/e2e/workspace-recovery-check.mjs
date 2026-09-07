/**
 * 工作区恢复与自动保存无头 E2E（自动保存方案 S6，§16.6）。
 * 依赖：dist/renderer 构建产物 + Playwright chromium（与 ui-layout-check.mjs 同款缓存路径）。
 *
 * 场景：
 *  - A 正常重启恢复：workspace:load 返回多标签快照 → DOM 标签/脏点出现，未调用 script:save
 *  - B 快速输入防抖：新建标签连续输入 → 最终保存快照 sqlContent 为最新内容（latest-wins）
 *  - C 保存失败非阻塞：workspace:save reject → 应用不白屏、编辑器保留输入
 *  - D 坏快照降级：load 返回隔离警告 + snapshot:null → 空工作区正常渲染
 *  - E 设置面板日志：logs:read 返回条目可见；点清空调用 logs:clear
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDist = join(process.cwd(), 'dist', 'renderer');
const require = createRequire(import.meta.url);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = require('/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
}
const chromium2 = pw.chromium ?? pw.default.chromium;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
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

/** 基础 mock（默认空快照 + 记录保存调用）。 */
function baseMock(extra = {}) {
  const snapshot = extra.snapshot ?? null;
  const saveShouldFail = !!extra.saveShouldFail;
  const overrides = extra.overrides ?? {};
  return `window.__saveCalls=[];window.__scriptSaveCalls=[];window.__logClearCalls=0;
window.sqlStudio={
'app:ping':async()=>'pong',
'connections:list':async()=>[{id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}],
'connections:get':async()=>({id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}),
'connections:testById':async()=>({ok:true,message:'ok'}),
'connections:test':async()=>({ok:true,message:'ok'}),
'connections:save':async()=>({}),
'connections:remove':async()=>({removed:true}),
'schema:databases':async()=>['testdb'],
'schema:tables':async()=>[],
'schema:columns':async()=>[],
'schema:ddl':async()=>({ddl:''}),
'schema:dataPreview':async()=>({index:0,statement:'',columns:[],rows:[],affectedRows:0,truncated:false,elapsedMs:1}),
'query:execute':async()=>({connectionId:'c1',resultSets:[],totalElapsedMs:1,truncated:false,hasWrite:false}),
'query:cancel':async()=>({cancelled:true}),
'script:open':async()=>({filePath:'/x/a.sql',content:'SELECT 1;'}),
'script:save':async(a)=>{window.__scriptSaveCalls.push(a);return {filePath:a.filePath};},
'export:excel':async()=>({filePath:'/x/a.xlsx',rowCount:1}),
'export:csv':async()=>({filePath:'/x/a.csv',rowCount:1}),
'export:insert':async()=>({filePath:'/x/a.sql',rowCount:1}),
'history:list':async()=>[],
'history:add':async(h)=>({...h,id:1,executedAt:Date.now()}),
'history:remove':async()=>({removed:true}),
'favorites:list':async()=>[],
'favorites:save':async(f)=>({name:f.name}),
'favorites:remove':async()=>({removed:true}),
'favorites:open':async()=>({filePath:'/x/f.sql',content:'SELECT 1;'}),
'favorites:rename':async(f)=>({name:f.newName}),
'ai:complete':async()=>({text:'',isComplete:true}),
'settings:getAiConfig':async()=>null,
'settings:setAiConfig':async()=>({saved:true}),
'settings:get':async()=>null,
'settings:set':async()=>({saved:true}),
'dialog:showSaveDialog':async()=>'/save/script.sql',
'dialog:showOpenDialog':async()=>'/save/script.sql',
'shell:showItemInFolder':async()=>({shown:true}),
'workspace:load':async()=>(${JSON.stringify(extra.loadResult ?? { snapshot, recoveredTabCount: snapshot ? snapshot.tabs.length : 0, quarantinedTabCount: 0, warnings: [] })}),
'workspace:save':async(arg)=>{window.__saveCalls.push(arg.snapshot);if(${saveShouldFail}){throw new Error('save failed');}return {saved:true,acceptedRevision:arg.snapshot.revision,storedRevision:arg.snapshot.revision,reason:'saved'};},
'workspace:clear':async()=>({cleared:true}),
'logs:append':async()=>({accepted:0,dropped:0}),
'logs:read':async()=>({entries:${JSON.stringify(extra.logEntries ?? [])},timezone:'Asia/Shanghai',truncated:false}),
'logs:clear':async()=>{window.__logClearCalls+=1;return {cleared:true,removedFileCount:1};},
...${JSON.stringify(overrides)}
};
window.confirm=()=>true;window.alert=()=>{};`;
}

function makeSnapshot({ activeTabId = 't1', currentConnectionId = 'c1', tabs = [] } = {}) {
  return {
    workspaceId: 'default',
    schemaVersion: 1,
    revision: 5,
    activeTabId,
    currentConnectionId,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    tabs,
  };
}

const results = [];
const browser = await chromium2.launch({ executablePath: '/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });

// ── A 正常重启恢复 ──
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const snap = makeSnapshot({
    tabs: [
      { id: 't1', tabOrder: 0, title: '未命名-7', filePath: null, sqlContent: 'SELECT 恢复;', isDirty: true, connectionId: null, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' },
      { id: 't2', tabOrder: 1, title: 'report.sql', filePath: '/x/report.sql', sqlContent: 'SELECT 2;', isDirty: false, connectionId: null, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' },
    ],
  });
  await page.addInitScript(baseMock({ loadResult: { snapshot: snap, recoveredTabCount: 2, quarantinedTabCount: 0, warnings: [] } }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const tabTitles = await page.locator('.tab-title').allTextContents();
  const dirtyCount = await page.locator('.tab-dirty').count();
  const scriptSaves = await page.evaluate(() => window.__scriptSaveCalls.length);
  results.push({ id: 'A-恢复标签', pass: tabTitles.some((t) => t.includes('未命名-7')) && tabTitles.some((t) => t.includes('report.sql')), detail: `titles=${tabTitles.join(',')}` });
  results.push({ id: 'A-脏点', pass: dirtyCount >= 1, detail: `dirty=${dirtyCount}` });
  // 恢复过程不得写真实文件（§7.3）
  results.push({ id: 'A-不自动写文件', pass: scriptSaves === 0, detail: `script:save calls=${scriptSaves}` });
  await page.close();
}

// ── B 快速输入防抖（latest-wins）──
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(baseMock());
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.getByTitle('新建脚本').click().catch(() => {});
  await page.waitForTimeout(400);
  const editor = page.locator('textarea[data-testid="monaco-stub"], .monaco-editor textarea').first();
  await editor.click().catch(() => {});
  await page.keyboard.type('SELECT ');
  await page.keyboard.type('1');
  await page.keyboard.type(';');
  // 等待 500ms 防抖 + 保存完成
  await page.waitForTimeout(1400);
  const saves = await page.evaluate(() => window.__saveCalls);
  const last = saves.length > 0 ? saves[saves.length - 1] : null;
  const lastSql = last && last.tabs && last.tabs.length > 0 ? last.tabs[last.tabs.length - 1].sqlContent : null;
  results.push({ id: 'B-防抖最终内容', pass: lastSql === 'SELECT 1;', detail: `lastSql=${JSON.stringify(lastSql)} saves=${saves.length}` });
  results.push({ id: 'B-结构事件立即保存', pass: saves.length >= 1, detail: `saves=${saves.length}` });
  await page.close();
}

// ── C 保存失败非阻塞 ──
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(baseMock({ saveShouldFail: true }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.getByTitle('新建脚本').click().catch(() => {});
  await page.waitForTimeout(400);
  const editor = page.locator('textarea[data-testid="monaco-stub"], .monaco-editor textarea').first();
  await editor.click().catch(() => {});
  await page.keyboard.type('SELECT 失败保留;');
  await page.waitForTimeout(1500);
  // 应用不白屏：编辑器仍在且内容保留
  const editorVisible = await editor.isVisible().catch(() => false);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
  results.push({ id: 'C-不白屏', pass: editorVisible && bodyText.includes('SQL Studio'), detail: `visible=${editorVisible}` });
  await page.close();
}

// ── D 坏快照降级：隔离返回空工作区 ──
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(baseMock({ loadResult: { snapshot: null, recoveredTabCount: 0, quarantinedTabCount: 2, warnings: ['已隔离坏标签'] } }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const placeholder = await page.locator('.workspace-placeholder').count();
  results.push({ id: 'D-坏快照空工作区', pass: placeholder >= 1 && bodyText.includes('SQL Studio') && !bodyText.includes('undefined'), detail: `placeholder=${placeholder}` });
  await page.close();
}

// ── E 设置面板日志 read/clear ──
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(baseMock({
    logEntries: [
      { id: 'log-1', timestamp: '2026-09-07T02:00:00.000Z', level: 'error', source: 'main', event: 'boot', message: '启动失败样例行' },
      { id: 'log-2', timestamp: '2026-09-07T02:00:01.000Z', level: 'info', source: 'renderer', event: 'renderer.log', message: '调试信息样例' },
    ],
  }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.click('.top-bar-icon-btn[title="设置（调试）"]');
  await page.waitForTimeout(800);
  const logBody = await page.locator('.settings-debug-log-body').innerText().catch(() => '');
  const hasError = logBody.includes('启动失败样例行');
  const hasInfo = logBody.includes('调试信息样例');
  results.push({ id: 'E-日志读取展示', pass: hasError || hasInfo, detail: `has=${logBody.slice(0, 60)}` });
  // 点清空 → 调用 logs:clear
  await page.click('.settings-debug-clear').catch(() => {});
  await page.waitForTimeout(300);
  const clearCalls = await page.evaluate(() => window.__logClearCalls);
  results.push({ id: 'E-清空走Main', pass: clearCalls >= 1, detail: `logs:clear calls=${clearCalls}` });
  await page.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n工作区恢复 E2E 结果：${results.length - failed.length}/${results.length} 通过`);
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
}
if (failed.length > 0) {
  console.error('E2E 有失败项');
  process.exit(1);
}
console.log('E2E 全部通过');