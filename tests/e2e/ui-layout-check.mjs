import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDist = join(process.cwd(), 'dist', 'renderer');
const outDir = join(process.cwd(), 'docs', 'ui-screenshots');
const require = createRequire(import.meta.url);
let pw; try { pw = await import('playwright'); } catch { pw = require('/home/admin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
const chromium2 = pw.chromium ?? pw.default.chromium;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf' };
const server = createServer(async (req,res)=>{ const p=decodeURIComponent(new URL(req.url,'http://x').pathname); const f=join(rendererDist, p==='/'?'index.html':p); try{const d=await readFile(f);res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');} });
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;
const mockScript=`window.sqlStudio={
'app:ping':async()=>'pong',
'connections:list':async()=>[{id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1},{id:'c2',name:'报表库',host:'10.0.0.5',port:3306,user:'etl',charset:'utf8mb4',database:'ads',createdAt:1,updatedAt:1}],
'connections:get':async()=>({id:'c1',name:'测试数据库',host:'127.0.0.1',port:3307,user:'root',charset:'utf8mb4',database:'testdb',createdAt:1,updatedAt:1}),
'connections:testById':async()=>({ok:true,message:'ok'}),'connections:test':async()=>({ok:true,message:'ok'}),'connections:save':async()=>({}),'connections:remove':async()=>({removed:true}),
'schema:databases':async()=>['testdb','ads','information_schema'],
'schema:tables':async()=>[{name:'users',type:'table',isView:false,comment:'用户表'},{name:'orders',type:'table',isView:false},{name:'v_active',type:'view',isView:true}],
'schema:columns':async()=>[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true},{name:'name',type:'varchar(64)',nullable:false,isPrimary:false,isUnique:false},{name:'email',type:'varchar(128)',nullable:true,isPrimary:false,isUnique:false}],
'schema:ddl':async()=>({ddl:'CREATE TABLE users (id bigint primary key)'}),
'schema:dataPreview':async()=>({index:0,statement:'SELECT',columns:[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true}],rows:[['1']],affectedRows:0,truncated:false,elapsedMs:1}),
'query:execute':async()=>({connectionId:'c1',totalElapsedMs:42,truncated:false,hasWrite:false,resultSets:[{index:0,statement:'SELECT * FROM users',columns:[{name:'id',type:'bigint',nullable:false,isPrimary:true,isUnique:true},{name:'name',type:'varchar(64)',nullable:false,isPrimary:false,isUnique:false},{name:'email',type:'varchar(128)',nullable:true,isPrimary:false,isUnique:false}],rows:[['1','张三','zhang@example.com'],['2','李四','li@example.com'],['3','王五',null]],affectedRows:0,truncated:false,elapsedMs:42}]}),
'query:cancel':async()=>({cancelled:true}),
'script:open':async()=>({filePath:'/x/a.sql',content:'SELECT 1;'}),'script:save':async(a)=>({filePath:a.filePath}),
'export:excel':async()=>({filePath:'/x/a.xlsx',rowCount:1}),'export:csv':async()=>({filePath:'/x/a.csv',rowCount:1}),'export:insert':async()=>({filePath:'/x/a.sql',rowCount:1}),
'history:list':async()=>[{id:1,sql:'SELECT * FROM users',connectionId:'c1',connectionName:'测试数据库',executedAt:Date.now(),elapsedMs:12,rowCount:3}],'history:add':async(h)=>({...h,id:1,executedAt:Date.now()}),'history:remove':async()=>({removed:true}),
'favorites:list':async()=>[{name:'每日统计',filePath:'/q/每日统计.sql',connectionId:'c1',tags:['日报'],createdAt:Date.now()}],'favorites:save':async(f)=>({name:f.name}),'favorites:remove':async()=>({removed:true}),'favorites:open':async()=>({filePath:'/x/f.sql',content:'SELECT 1;'}),'favorites:rename':async(f)=>({name:f.newName}),
'ai:complete':async()=>({text:'',isComplete:true}),'settings:getAiConfig':async()=>null,'settings:setAiConfig':async()=>({saved:true}),'settings:get':async()=>null,'settings:set':async()=>({saved:true}),
'dialog:showSaveDialog':async()=>'/save/script.sql','dialog:showOpenDialog':async()=>'/save/script.sql','shell:showItemInFolder':async()=>({shown:true})};
window.confirm=()=>true;window.alert=()=>{};`;
const sizes=[{w:1440,h:900,label:'1440x900'},{w:1280,h:800,label:'1280x800'},{w:1024,h:700,label:'1024x700'},{w:900,h:700,label:'900x700'}];
const browser=await chromium2.launch({executablePath:'/home/admin/.cache/ms-playwright/chromium-1134/chrome-linux/chrome',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
const results=[];
for(const {w,h,label} of sizes){
  const page=await browser.newPage({viewport:{width:w,height:h}});
  await page.addInitScript(mockScript);
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForTimeout(1100);
  const ov1=await page.evaluate(()=>({d:document.documentElement.scrollWidth,c:document.documentElement.clientWidth}));
  await page.screenshot({path:join(outDir,`S3-${label}-empty.png`)});
  await page.click('text=测试数据库').catch(()=>{});
  await page.waitForTimeout(800);
  await page.screenshot({path:join(outDir,`S3-${label}-conn.png`)});
  await page.getByTitle('新建脚本').click().catch(()=>{});
  await page.waitForTimeout(500);
  const stub=page.locator('textarea[data-testid="monaco-stub"], .monaco-editor textarea').first();
  await page.keyboard.type('SELECT * FROM users;');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1200);
  const ov2=await page.evaluate(()=>({d:document.documentElement.scrollWidth,c:document.documentElement.clientWidth}));
  const hasToolbar=await page.locator('.result-toolbar').count();
  const hasResize=await page.locator('.result-resize-handle').count();
  await page.screenshot({path:join(outDir,`S3-${label}-result.png`)});
  // 打开历史/设置弹窗验证统一 Modal
  await page.click('.top-bar-icon-btn >> nth=0').catch(()=>{}); // 历史
  await page.waitForTimeout(500);
  const modalOpen=await page.locator('.modal-panel').count();
  await page.screenshot({path:join(outDir,`S3-${label}-modal.png`)});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const modalAfterEsc=await page.locator('.modal-panel').count();
  const hOverflow=(ov1.d>ov1.c+2)||(ov2.d>ov2.c+2);
  results.push({label,w,h,hOverflow,hasToolbar,hasResize,modalOpen,modalAfterEsc});
  await page.close();
}
await browser.close();server.close();
console.log(JSON.stringify(results,null,2));
