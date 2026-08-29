import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const rendererDist = join(process.cwd(), 'dist', 'renderer');
const require = createRequire(import.meta.url);
let pw; try { pw = await import('playwright'); } catch { pw = require('/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
const chromium2 = pw.chromium ?? pw.default.chromium;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf' };
const server = createServer(async (req,res)=>{ const p=decodeURIComponent(new URL(req.url,'http://x').pathname); const f=join(rendererDist, p==='/'?'index.html':p); try{const d=await readFile(f);res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');} });
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;
const baseMock=`window.sqlStudio={
'connections:list':async()=>[{id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}],
'connections:get':async()=>({id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}),
'connections:testById':async()=>({ok:true,message:'ok'}),'connections:test':async()=>({ok:true,message:'ok'}),'connections:save':async()=>({}),'connections:remove':async()=>({removed:true}),
'schema:databases':async()=>['testdb'],'schema:tables':async()=>[{name:'users',type:'table',isView:false}],'schema:columns':async()=>[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],
'schema:ddl':async()=>({ddl:'CREATE'}),'schema:dataPreview':async()=>({index:0,statement:'S',columns:[],rows:[],affectedRows:0,truncated:false,elapsedMs:1}),
'query:cancel':async()=>({cancelled:true}),
'script:open':async()=>({filePath:'/x/a.sql',content:'SELECT 1;'}),'script:save':async(a)=>({filePath:a.filePath}),
'history:list':async()=>[],'history:remove':async()=>({removed:true}),'favorites:list':async()=>[],'favorites:remove':async()=>({removed:true}),'favorites:open':async()=>({}),
'settings:get':async()=>null,'settings:set':async()=>({saved:true}),'settings:getAiConfig':async()=>null,'settings:setAiConfig':async()=>({saved:true}),
'ai:complete':async()=>({text:'',isComplete:true}),'dialog:showOpenDialog':async()=>'/x/a.sql','dialog:showSaveDialog':async()=>'/x/a.sql','shell:showItemInFolder':async()=>({shown:true})};
window.confirm=()=>true;window.alert=()=>{};`;

const browser=await chromium2.launch({executablePath:'/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});

// 场景1：执行中（query:execute 挂起 → 停止按钮可见）
{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.addInitScript(baseMock.replace("'query:execute':", "never()" ).replace("'query:cancel':async()=>", "'query:execute':()=>new Promise(()=>{}),'query:cancel':async()=>"));
  await page.goto(base,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('text=测试数据库'); await page.waitForTimeout(600);
  await page.getByTitle('新建脚本').click(); await page.waitForTimeout(800);
  await page.locator('.monaco-editor textarea').first().click().catch(()=>{});
  await page.keyboard.type('SELECT * FROM users;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1000);
  const stopBtn=await page.locator('.sql-editor-stop').count();
  const runBtn=await page.locator('.sql-editor-run').count();
  const statusText=await page.locator('.status-bar').textContent();
  console.log('执行中: stopBtn=',stopBtn,' runBtn=',runBtn,' status=',statusText?.replace(/\s+/g,' ').trim());
  await page.screenshot({path:join(rendererDist,'..','..','docs','ui-screenshots','S5-executing.png')});
  await page.close();
}

// 场景2：查询错误
{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errMock=baseMock.replace("'query:cancel':async()=>({cancelled:true}),", "'query:execute':async()=>{throw new Error('Table \"bad\" doesn\\'t exist')},'query:cancel':async()=>({cancelled:true}),");
  await page.addInitScript(errMock);
  await page.goto(base,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('text=测试数据库'); await page.waitForTimeout(600);
  await page.getByTitle('新建脚本').click(); await page.waitForTimeout(800);
  await page.locator('.monaco-editor textarea').first().click().catch(()=>{});
  await page.keyboard.type('SELECT * FROM bad;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const errPanel=await page.locator('.result-error').count();
  const errText=await page.locator('.result-error-msg').textContent();
  const statusText=await page.locator('.status-bar').textContent();
  console.log('错误: errPanel=',errPanel,' errText=',errText?.trim(),' status=',statusText?.replace(/\s+/g,' ').trim());
  await page.screenshot({path:join(rendererDist,'..','..','docs','ui-screenshots','S5-error.png')});
  await page.close();
}

// 场景3：截断
{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const truncMock=baseMock.replace("'query:cancel':async()=>({cancelled:true}),", "'query:execute':async()=>({connectionId:'c1',totalElapsedMs:88,truncated:true,hasWrite:false,resultSets:[{index:0,statement:'SELECT',columns:[{name:'a',type:'int',nullable:true,isPrimary:false,isUnique:false}],rows:[['1']],affectedRows:0,truncated:true,elapsedMs:88}]}),'query:cancel':async()=>({cancelled:true}),");
  await page.addInitScript(truncMock);
  await page.goto(base,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('text=测试数据库'); await page.waitForTimeout(600);
  await page.getByTitle('新建脚本').click(); await page.waitForTimeout(800);
  await page.locator('.monaco-editor textarea').first().click().catch(()=>{});
  await page.keyboard.type('SELECT * FROM big;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const warnInToolbar=await page.locator('.result-toolbar .status-warn, .result-tab .result-tab-meta').count();
  const warnStatus=await page.locator('.result-status .status-warn').count();
  const statusBarWarn=await page.locator('.status-bar .status-warn').count();
  console.log('截断: toolbarWarn=',warnInToolbar,' resultStatusWarn=',warnStatus,' statusBarWarn=',statusBarWarn);
  await page.screenshot({path:join(rendererDist,'..','..','docs','ui-screenshots','S5-truncated.png')});
  await page.close();
}

await browser.close(); server.close();
