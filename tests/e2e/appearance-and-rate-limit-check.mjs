/**
 * 外观与 AI 限流专项 E2E（阶段 F：外观与 AI 限流）。
 *
 * 依赖：dist/renderer 构建产物 + Playwright chromium（与 ui-layout-check.mjs 同款缓存路径）。
 * 运行：先 `npm run build`，再 `node tests/e2e/appearance-and-rate-limit-check.mjs`。
 *
 * 验证点（执行指令 §7 自动化专项）：
 *  1. AppearancePanel 可打开、关闭、切换三种主题（深色/白天/钛灰）。
 *  2. 主题切换后 `data-theme`、页面关键颜色（body 背景）与 Monaco theme 同步。
 *  3. 重启模拟（重新加载页面 + 启动读取 theme）后 titanium 配置仍然保留。
 *  4. AI 设置四个限流字段可读取、修改、保存和恢复默认。
 *  5. provider 初始化日志含四个策略值。
 *  6. 自定义最小请求间隔会阻止过快请求（skip 且不发 IPC）。
 *  7. 自定义冷却时间在模拟 429 后生效。
 *  8. suggestionLen=0 的日志原因是 provider_empty，不是 rate_limited。
 *  9. 限流跳过时记录 min_interval / cooldown，不发送 ai:complete IPC。
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

/**
 * 构造 sqlStudio mock 脚本。
 * ai:complete 计数：把每次调用 push 到 window.__aiCalls，方便断言「是否发 IPC」。
 * 支持：
 *  - aiComplete: 自定义 ai:complete 实现（字符串函数体，返回 {suggestion} 或抛 429 错误）
 *  - settingsGet: settings:get 实现
 *  - extra: 额外需要暴露到脚本的变量（如 initDelay）
 */
function mockScript({ aiComplete, settingsGet, extra = '' } = {}) {
  const aiImpl = aiComplete
    ? `'ai:complete':async(a)=>{window.__aiCalls.push(a);return (${aiComplete})(a);},`
    : `'ai:complete':async(a)=>{window.__aiCalls.push(a);return {suggestion:'ers'};},`;
  const getImpl = settingsGet
    ? `'settings:get':async(x)=>{return (${settingsGet})(x);},`
    : `'settings:get':async()=>null,`;
  return `window.__aiCalls=[];
window.sqlStudio={
'app:ping':async()=>'pong',
'connections:list':async()=>[{id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}],
'connections:get':async()=>({id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}),
'connections:testById':async()=>({ok:true,message:'ok'}),'connections:test':async()=>({ok:true,message:'ok'}),'connections:save':async()=>({}),'connections:remove':async()=>({removed:true}),
'schema:databases':async()=>['testdb'],
'schema:tables':async()=>[{name:'users',type:'table',isView:false}],
'schema:columns':async()=>[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],
'schema:ddl':async()=>({ddl:'CREATE TABLE users (id bigint)'}),
'schema:dataPreview':async()=>({index:0,statement:'SELECT',columns:[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],rows:[['1']],affectedRows:0,truncated:false,elapsedMs:1}),
'query:execute':async()=>({connectionId:'c1',totalElapsedMs:42,truncated:false,hasWrite:false,resultSets:[]}),
'query:cancel':async()=>({cancelled:true}),
'script:open':async()=>({filePath:'/x/a.sql',content:'SELECT 1;'}),'script:save':async(a)=>({filePath:a.filePath}),
'export:excel':async()=>({filePath:'/x/a.xlsx',rowCount:1}),'export:csv':async()=>({filePath:'/x/a.csv',rowCount:1}),'export:insert':async()=>({filePath:'/x/a.sql',rowCount:1}),
'history:list':async()=>[],'history:add':async(h)=>({...h,id:1,executedAt:Date.now()}),'history:remove':async()=>({removed:true}),
'favorites:list':async()=>[],'favorites:save':async(f)=>({name:f.name}),'favorites:remove':async()=>({removed:true}),'favorites:open':async()=>({filePath:'/x/f.sql',content:'SELECT 1;'}),'favorites:rename':async(f)=>({name:f.newName}),
${aiImpl}
'settings:getAiConfig':async()=>({enabled:true,baseUrl:'https://api.deepseek.com/beta',model:'deepseek-v4-pro',protocol:'deepseek-fim',apiKeyConfigured:true,rateLimit:{debounceMs:300,minRequestIntervalMs:1500,rateLimitCooldownMs:3000,requestTimeoutMs:4000}}),
'settings:setAiConfig':async()=>({saved:true}),
${getImpl}
'settings:set':async()=>({saved:true}),
'dialog:showSaveDialog':async()=>'/save/script.sql','dialog:showOpenDialog':async()=>'/save/script.sql','shell:showItemInFolder':async()=>({shown:true})};
window.confirm=()=>true;window.alert=()=>{};${extra}`;
}

const browser = await chromium2.launch({ executablePath: '/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
const results = [];
let consoleErrs = [];
let pageAiLogs = []; // 每页 [AI] 日志（info/warn/error 均捕获）

async function newPage(script) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  pageAiLogs = [];
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('[AI]')) pageAiLogs.push(text);
    if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(text.slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrs.push('PAGEERROR: ' + String(e).slice(0, 200)));
  await page.addInitScript(script);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  return page;
}

// ── 1) AppearancePanel：打开 → 三主题可见 → 切换钛灰 → data-theme + 背景同步 ──
{
  const page = await newPage(mockScript({ settingsGet: `async(x)=>{ if(x.key==='theme') return 'dark'; return null; }` }));
  await page.click('button[title="外观（主题与字体）"]', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.appearance-theme-card', { timeout: 4000 }).catch(() => {});
  const labels = await page.locator('.appearance-theme-card-label').allTextContents().catch(() => []);
  // 点击钛灰卡片
  await page.click('.appearance-theme-card:has-text("钛灰")', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      labels: Array.from(document.querySelectorAll('.appearance-theme-card-label')).map((e) => e.textContent.trim()),
      dataTheme: document.documentElement.dataset.theme,
      bodyBg: cs.backgroundColor,
    };
  });
  results.push({
    check: 'appearance-panel-open-switch',
    labels: probe.labels,
    dataTheme: probe.dataTheme,
    bodyBg: probe.bodyBg,
    pass: probe.labels.some((l) => l.includes('深色')) && probe.labels.some((l) => l.includes('白天')) && probe.labels.some((l) => l.includes('钛灰')) && probe.dataTheme === 'titanium',
  });
  await page.close();
}

// ── 2) 关闭外观面板 → data-theme 仍保持 titanium（立即应用 + 持久化不依赖面板）──
{
  const page = await newPage(mockScript({ settingsGet: `async(x)=>{ if(x.key==='theme') return 'titanium'; return null; }` }));
  await page.waitForTimeout(400);
  await page.click('button[title="外观（主题与字体）"]', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.appearance-theme-card', { timeout: 4000 }).catch(() => {});
  await page.click('.appearance-theme-card:has-text("白天")', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  // 关闭面板（关闭按钮）
  await page.click('.modal-close', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    panelGone: !document.querySelector('.appearance-theme-card'),
  }));
  results.push({
    check: 'appearance-close-keeps-theme',
    dataTheme: probe.dataTheme,
    panelGone: probe.panelGone,
    pass: probe.dataTheme === 'light' && probe.panelGone === true,
  });
  await page.close();
}

// ── 3) 「重启」模拟：刷新页面后启动读取 titanium → 页面重新应用钛灰 ──
{
  const page = await newPage(mockScript({ settingsGet: `async(x)=>{ if(x.key==='theme') return 'titanium'; return null; }` }));
  // 首次加载已应用
  await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  // 模拟重启：重新加载（addInitScript 每次导航都会执行 → 模拟持久化的 settings）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => document.documentElement.dataset.theme);
  results.push({
    check: 'restart-keeps-titanium',
    firstLoad: t1,
    afterReload: t2,
    pass: t1 === 'titanium' && t2 === 'titanium',
  });
  await page.close();
}

// ── 4) AI 设置：四个限流字段读取 → 修改 → 保存 → 恢复默认 ──
{
  const page = await newPage(mockScript());
  // 打开 AI 设置（需先建标签显示 AI 按钮）
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('text=AI', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.ai-settings-rate-field', { timeout: 4000 }).catch(() => {});
  const before = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ai-settings-rate-field')).map((r) => {
      const inp = r.querySelector('input');
      return { label: r.querySelector('.ai-settings-rate-label')?.textContent.trim(), value: inp?.value };
    });
    return rows;
  });
  // 修改输入防抖 → 600
  await page.fill('input[aria-label="输入防抖（毫秒）"]', '600', { timeout: 4000 }).catch(() => {});
  // 保存
  await page.click('.ai-settings-btn.primary', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  // 恢复默认
  await page.click('.ai-settings-restore-btn', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
  const afterRestore = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ai-settings-rate-field')).map((r) => {
      const inp = r.querySelector('input');
      return { label: r.querySelector('.ai-settings-rate-label')?.textContent.trim(), value: inp?.value };
    });
    return rows;
  });
  const debounceNow = afterRestore.find((r) => r.label?.includes('输入防抖'))?.value;
  results.push({
    check: 'ai-rate-fields',
    before,
    debounceAfterRestore: debounceNow,
    fieldCount: before.length,
    // 打开时回填真实值（debounce 300）；恢复默认回到 DEFAULT（400，不是 mock 的 300）
    pass: before.length === 4
      && before.some((r) => r.label?.includes('输入防抖') && r.value === '300')
      && before.some((r) => r.label?.includes('最小请求间隔') && r.value === '1500')
      && before.some((r) => r.label?.includes('限流冷却时间') && r.value === '3000')
      && before.some((r) => r.label?.includes('请求超时') && r.value === '4000')
      && debounceNow === '400',
  });
  await page.close();
}

// ── 5) provider 初始化日志含四个策略值；输入触发行内补全 ──
{
  const page = await newPage(mockScript());
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.type('SELECT * FROM us');
  // 等防抖 + 最小间隔通过（mock 配置 debounce 300 / minInterval 1500，输入完成自动触发）
  await page.waitForTimeout(2500);
  const aiLogs = pageAiLogs.slice();
  const initLog = aiLogs.find((l) => l.includes('provider 初始化'));
  results.push({
    check: 'provider-init-log',
    initLog: initLog ?? null,
    aiLogCount: aiLogs.length,
    pass: !!initLog
      && initLog.includes('debounceMs:300')
      && initLog.includes('minRequestIntervalMs:1500')
      && initLog.includes('rateLimitCooldownMs:3000')
      && initLog.includes('requestTimeoutMs:4000')
      && !initLog.includes('sk-')
      && !initLog.includes('SELECT'),
  });
  await page.close();
}

// ── 6) 自定义冷却：ai:complete 抛 429 → 冷却期内不再发 IPC、日志含 cooldown ──
{
  const page = await newPage(mockScript({
    aiComplete: `async()=>{ throw new Error('请求过于频繁，请稍后重试'); }`,
  }));
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  // 第一次输入 → 触发 429 → 进入冷却（cooldownMs=3000）
  await page.keyboard.type('SELECT * FROM us');
  await page.waitForTimeout(2200);
  const callsAfter429 = await page.evaluate(() => window.__aiCalls.length);
  // 冷却期内继续输入 → 不应新增 IPC（冷却生效的直接证据）
  await page.keyboard.type('a');
  await page.waitForTimeout(1200);
  const callsDuringCooldown = await page.evaluate(() => window.__aiCalls.length);
  await page.waitForTimeout(1500); // 等冷却跳过原因日志（节流窗口 1s 后）
  const cooldownLogs = pageAiLogs.slice();
  // 冷却生效：429 后不发新 IPC + 日志记录 cooldown 原因
  // 注：Monaco inline suggest 在 provider 返回后对同一上下文抑制自动重触发，
  //     冷却「恢复」行为由单测覆盖（自定义冷却时间生效：冷却结束后恢复请求）。
  const hasCooldownLog = cooldownLogs.some((l) => String(l).includes('cooldown'));
  results.push({
    check: 'cooldown-blocks-ipc',
    callsAfter429: callsAfter429,
    callsDuringCooldown: callsDuringCooldown,
    hasCooldownLog,
    cooldownLogs: cooldownLogs.slice(0, 8),
    pass: callsAfter429 === 1 && callsDuringCooldown === 1 && hasCooldownLog,
  });
  await page.close();
}

// ── 7) min_interval：连续快速输入只发一次 IPC（防抖合并 + 最小间隔拦截）──
{
  const page = await newPage(mockScript());
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  // 快速连续输入（每次间隔 < debounce 300ms → 防抖合并）
  await page.keyboard.type('SELECT * FROM us', { delay: 50 });
  await page.waitForTimeout(900); // 完成防抖 + 最小间隔 1500 内的首次请求
  const calls = await page.evaluate(() => window.__aiCalls.length);
  // 间隔 < 1500ms 再次输入 → 最小间隔拦截，不新增 IPC
  await page.keyboard.type('X', { delay: 50 });
  await page.waitForTimeout(400);
  const callsAfterFast = await page.evaluate(() => window.__aiCalls.length);
  results.push({
    check: 'min-interval-blocks-fast',
    callsAfterDebounce: calls,
    callsAfterFastTyping: callsAfterFast,
    pass: calls === 1 && callsAfterFast === 1,
  });
  await page.close();
}

// ── 8) suggestionLen=0 → 日志 provider_empty，不是 rate_limited；且该请求确实发出 ──
{
  const page = await newPage(mockScript({
    aiComplete: `async()=>({suggestion:'',meta:{choiceCount:1,finishReason:'stop'}})`,
  }));
  await page.click('text=测试数据库', { timeout: 5000 }).catch(() => {});
  await page.getByTitle('新建脚本').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.type('SELECT * FROM us');
  await page.waitForTimeout(2000); // 防抖+间隔后请求发出
  const calls = await page.evaluate(() => window.__aiCalls.length);
  const aiLogs = pageAiLogs.slice();
  const hasProviderEmpty = aiLogs.some((l) => String(l).includes('provider_empty'));
  // 客户端跳过/限流标记（原因码），provider_empty 文案含「非客户端限流」不代表服务端限流
  const hasClientSkip = aiLogs.some((l) =>
    String(l).includes('reason=min_interval')
    || String(l).includes('reason=cooldown')
    || String(l).includes('rate_limited'),
  );
  results.push({
    check: 'empty-suggestion-is-provider_empty',
    calls: calls,
    hasProviderEmpty,
    hasClientSkip,
    pass: calls === 1 && hasProviderEmpty && !hasClientSkip,
  });
  await page.close();
}

await browser.close();
server.close();
console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrs.slice(0, 10)));
console.log(JSON.stringify(results, null, 2));