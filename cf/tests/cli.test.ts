import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile,readdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
const cli=new URL('../cli/bin/pneuma-space.mjs',import.meta.url).pathname;
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'pneuma-space-cli-test-'));await mkdir(join(dir,'app'));await writeFile(join(dir,'pneuma-space.json'),JSON.stringify({contract:'pneuma-space.cf/1',runtime:'node',entry:'server.mjs',capabilities:{kv:{}}}));await writeFile(join(dir,'app/server.mjs'),'console.log("application")');return dir;}
test('CF-21 packaging includes only the application directory and ignores private setup state',async()=>{
 const dir=await fixture();try{
  const first=JSON.parse(execFileSync(process.execPath,[cli,'package',dir],{encoding:'utf8'}));
  await mkdir(join(dir,'.pneuma-space'));await writeFile(join(dir,'.pneuma-space/credentials.json'),'private-token-must-not-ship');await writeFile(join(dir,'AGENTS.md'),'Instructions must stay local');
  const second=JSON.parse(execFileSync(process.execPath,[cli,'package',dir],{encoding:'utf8'}));assert.deepEqual(second,first);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CF-21 packaging refuses symlinks into local credentials',async()=>{
 const dir=await fixture();try{await writeFile(join(dir,'secret.json'),'secret');await symlink(join(dir,'secret.json'),join(dir,'app/secret.json'));assert.throws(()=>execFileSync(process.execPath,[cli,'package',dir],{encoding:'utf8',stdio:'pipe'}),/symlinks/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('CF-21 the installed npm bin symlink executes the CLI',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pneuma-space-cli-bin-'));
 try{const bin=join(dir,'pneuma-space');await symlink(cli,bin);const output=execFileSync(process.execPath,[bin,'help'],{encoding:'utf8'});assert.match(output,/Scaffold, publish and measure requests/);}finally{await rm(dir,{recursive:true,force:true});}
});

import http from 'node:http';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
// @ts-expect-error The packaged CLI is a plain Node script.
import {publish,discard,unmanage} from '../cli/bin/pneuma-space.mjs';
const run=promisify(execFile),repositoryCli=new URL('../scripts/cli.mjs',import.meta.url).pathname,end=Date.UTC(2026,10,25,12);
type Recorded={method:string;path:string;body?:Record<string,unknown>;manager?:string};
async function space(apps:Record<string,unknown>[]=[]){
 const requests:Recorded[]=[];
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const path=req.url!,reply=(value:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json',...(path.endsWith('/auth/login')?{'set-cookie':'session=s; Path=/'}:{})});res.end(JSON.stringify(value));};
  if(path==='/r2')return reply({});
  const body=text?JSON.parse(text):undefined;
  if(!path.startsWith('/api/v1/auth/'))requests.push({method:req.method!,path:path.slice(7),...(body&&{body}),...(req.headers['x-pneuma-space-manager']&&{manager:String(req.headers['x-pneuma-space-manager'])})});
  if(path.endsWith('/auth/login'))return reply({csrf:'c',tenants:[{id:'t'}]});
  if(path.endsWith('/auth/logout'))return reply({});
  if(path==='/api/v1/tenants/t/apps'&&req.method==='GET')return reply({items:apps});
  if(path==='/api/v1/tenants/t/apps'){apps.push({id:'a_new',name:body.name,url:'',expiresAt:body.ephemeral?end:null});return reply(apps.at(-1),201);}
  if(path.endsWith('/uploads'))return reply({uploadId:'up',url:origin+'/r2',headers:{},expiresAt:Date.now()+60000},201);
  if(path.endsWith('/releases'))return reply({id:'a_new',current:{number:1},expiresAt:apps.at(-1)?.expiresAt??null});
  if(path.endsWith('/actions'))return reply({status:'purged'});
  if(path.endsWith('/manager'))return reply({manager:null});
  reply({error:{code:'not_found',message:'Not found.'}},404);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address(),origin='http://127.0.0.1:'+(address&&typeof address!=='string'?address.port:0);
 const dir=await mkdtemp(join(tmpdir(),'pneuma-space-cli-space-'));
 await mkdir(join(dir,'site/public'),{recursive:true});
 await writeFile(join(dir,'site/pneuma-space.json'),JSON.stringify({contract:'pneuma-space.cf/1',runtime:'static',entry:'public/index.html',capabilities:{static:{dir:'public'}}}));
 await writeFile(join(dir,'site/public/index.html'),'Page');
 await writeFile(join(dir,'credentials.json'),JSON.stringify({origin,account:'owner',key:'key'}));
 const cli=(...args:string[])=>run(process.execPath,[repositoryCli,...args],{env:{...process.env,PNEUMA_SPACE_CREDENTIALS:join(dir,'credentials.json')}});
 return {requests,cli,site:join(dir,'site'),origin,close:async()=>{server.closeAllConnections();server.close();await rm(dir,{recursive:true,force:true});}};
}
async function project(app:Record<string,unknown>|null=null){
 const dir=await fixture(),privateDir=join(dir,'.pneuma-space'),calls:Recorded[]=[],lines:string[]=[];
 await mkdir(privateDir);
 const server=http.createServer((req,res)=>{req.resume();res.end();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address(),put='http://127.0.0.1:'+(address&&typeof address!=='string'?address.port:0)+'/r2';
 const request=async(path:string,body:Record<string,unknown>|undefined,method='GET',_key?:string,headers:Record<string,string>={})=>{
  calls.push({method,path,...(body&&{body}),...(headers['x-pneuma-space-manager']&&{manager:headers['x-pneuma-space-manager']})});
  if(path.endsWith('/apps'))return {id:'a_new',name:'demo',expiresAt:body?.ephemeral?end:null};
  if(path.endsWith('/uploads'))return {uploadId:'up',url:put,headers:{},expiresAt:Date.now()+60000};
  if(path.endsWith('/releases'))return {id:'a_new',current:{number:1},expiresAt:calls[0].body?.ephemeral?end:null};
  return {status:'purged'};
 };
 const w={directory:dir,privateDir,project:{name:'demo',tenant:'t',origin:'https://space.test',createKey:'first',app},client:{origin:'https://space.test',request,headers:{}}};
 const log=console.log;console.log=(line:string)=>lines.push(line);
 return {w,calls,lines,close:async()=>{console.log=log;server.close();await rm(dir,{recursive:true,force:true});}};
}
test('CF-29 cli.mjs publish --ephemeral --ttl creates the app ephemeral, states the kind and prints its id and end',async()=>{
 const s=await space();try{
  const {stdout}=await s.cli('publish',s.site,'preview','--ephemeral','--ttl','120');
  assert.deepEqual(s.requests.filter(r=>r.method==='POST').map(r=>[r.path,r.body?.ephemeral]),[['/tenants/t/apps',{ttlSeconds:120}],['/apps/a_new/uploads',true],['/apps/a_new/releases',true]]);
  assert.deepEqual(JSON.parse(stdout),{id:'a_new',url:'',release:1,expiresAt:new Date(end).toISOString()});
 }finally{await s.close();}
});
test('CF-29 cli.mjs --ttl without --ephemeral, or not whole seconds, is a usage error before any request',async()=>{
 const s=await space();try{
  for(const args of [['--ttl','60'],['--ephemeral','--ttl','1.5']])await assert.rejects(s.cli('publish',s.site,'preview',...args),/--ttl takes whole seconds and needs --ephemeral/);
  assert.deepEqual(s.requests,[]);
 }finally{await s.close();}
});
test('CF-29 cli.mjs discard --app discards that app id without looking up the name',async()=>{
 const s=await space();try{
  await s.cli('discard','preview','--app','a_given');
  assert.deepEqual(s.requests,[{method:'POST',path:'/apps/a_given/actions',body:{type:'discard'}}]);
 }finally{await s.close();}
});
test('CF-30 cli.mjs --manager names the manager on every write and sets it on publish',async()=>{
 const s=await space();try{
  await s.cli('publish',s.site,'board','--manager','deployer','--manager-url','https://deploy.test/board');
  const writes=s.requests.filter(r=>r.method==='POST');
  assert.deepEqual(writes.map(r=>r.manager),['deployer','deployer','deployer']);
  assert.deepEqual(writes.map(r=>r.body?.manager),[{name:'deployer',url:'https://deploy.test/board'},undefined,{name:'deployer',url:'https://deploy.test/board'}]);
 }finally{await s.close();}
});
test('CF-30 cli.mjs unmanage deletes the manager naming it',async()=>{
 const s=await space([{id:'a_board',name:'board'}]);try{
  await s.cli('unmanage','board','--manager','deployer');
  assert.deepEqual(s.requests.at(-1),{method:'DELETE',path:'/apps/a_board/manager',manager:'deployer'});
 }finally{await s.close();}
});
test('CF-29 the packaged CLI publishes an ephemeral app, states the kind and prints its id and end',async()=>{
 const p=await project();try{
  await publish(p.w,{ephemeral:true,ttl:'120'});
  assert.deepEqual(p.calls.map(c=>c.body?.ephemeral),[{ttlSeconds:120},true,true]);
  assert.ok(p.lines.some(line=>line.includes('a_new'))&&p.lines.some(line=>line.includes(new Date(end).toISOString())));
 }finally{await p.close();}
});
test('CF-29 the packaged CLI discard ends the project app, so the next publish creates a new one',async()=>{
 const p=await project({id:'a_old',name:'demo',expiresAt:end});try{
  await discard(p.w,{});
  assert.deepEqual(p.calls,[{method:'POST',path:'/apps/a_old/actions',body:{type:'discard'}}]);
  assert.deepEqual([p.w.project.app,p.w.project.createKey!=='first'],[null,true]);
 }finally{await p.close();}
});
test('CF-30 the packaged CLI --manager names the manager on upload and release and unmanage clears it naming it',async()=>{
 const p=await project({id:'a_board',name:'demo',expiresAt:null});try{
  await publish(p.w,{manager:'deployer'});
  await unmanage(p.w,{manager:'deployer'});
  assert.deepEqual(p.calls.map(c=>[c.method,c.path,c.manager,c.body?.manager]),[['POST','/apps/a_board/uploads','deployer',undefined],['POST','/apps/a_board/releases','deployer',{name:'deployer'}],['DELETE','/apps/a_board/manager','deployer',undefined]]);
 }finally{await p.close();}
});
test('CF-29 the packaged CLI refuses --ttl without --ephemeral before reading the project',async()=>{
 await assert.rejects(run(process.execPath,[cli,'publish',tmpdir(),'--ttl','60']),/--ttl takes whole seconds and needs --ephemeral/);
});

const cliRoot=new URL('../cli/',import.meta.url).pathname,setupToken='a'.repeat(64);
const files=async(dir:string)=>(await readdir(dir,{recursive:true,withFileTypes:true})).filter(entry=>!entry.isDirectory()).map(entry=>relative(dir,join(entry.parentPath,entry.name))).sort();
const projectFiles=async(dir:string)=>(await files(dir)).filter(file=>!/^\.pneuma-space\/[^/]+\.json$/.test(file));
/** Every file a whole project made from the CLI package at `tool` holds, apart from its private JSON state. */
async function whole(tool:string){
 const skill=await files(join(tool,'templates/skill'));
 return [...await files(join(tool,'templates/demo')),...['.agents','.claude','.cursor','.gemini','.github'].flatMap(folder=>skill.map(file=>folder+'/skills/pneuma-space/'+file)),'CLAUDE.md','GEMINI.md','.github/copilot-instructions.md','.gitignore','package.json',...(await files(tool)).map(file=>'.pneuma-space/tool/'+file)].sort();
}
/** The control API, storage and app that `start` reaches. A preload sends the CLI's https://space.test requests here. */
async function setupSpace(){
 const calls:string[]=[];
 const server=http.createServer(async(req,res)=>{
  for await(const _chunk of req);
  const key=req.method+' '+req.url;calls.push(key);
  const routes:Record<string,unknown>={
   'GET /api/v1/me':{tenants:[{id:'t'}]},
   'POST /api/v1/tenants/t/apps':{id:'a_new',name:'demo',expiresAt:null},
   'POST /api/v1/apps/a_new/uploads':{uploadId:'up',url:'https://space.test/r2',headers:{},expiresAt:Date.now()+60000},
   'PUT /r2':{},
   'POST /api/v1/apps/a_new/releases':{id:'a_new',current:{number:1},expiresAt:null},
   'GET /api/v1/apps/a_new':{current:{manifest:{runtime:'node'}},policy:{idleSeconds:300},runtime:{state:'running'},wake:null,usage:{}},
   'POST /apps/demo/api/proof':{boot:'b'},'GET /apps/demo/api/proof':{boot:'b'},
  };
  res.writeHead(key in routes?200:404,{'content-type':'application/json'});res.end(JSON.stringify(routes[key]??{error:{message:'Not found.'}}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address(),origin='http://127.0.0.1:'+(address&&typeof address!=='string'?address.port:0);
 const root=await mkdtemp(join(tmpdir(),'pneuma-space-setup-')),preload=join(root,'space.mjs'),dir=join(root,'demo');
 await writeFile(preload,`const send=globalThis.fetch;globalThis.fetch=(url,init)=>send(String(url).replace('https://space.test',${JSON.stringify(origin)}),init);\n`);
 const cli=(command:string,{node=process.execPath,tool=cliRoot}={})=>{
  const child=run(node,['--import',preload,join(tool,'bin/pneuma-space.mjs'),command,dir,'--origin','https://space.test','--tenant','t','--token-stdin']);
  child.child.stdin!.end(setupToken);return child;
 };
 return {calls,root,dir,cli,close:async()=>{server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});}};
}
test('CF-33 start sets up, publishes and measures a project in an empty directory',async()=>{
 const s=await setupSpace();try{
  await s.cli('start');
  assert.deepEqual(await projectFiles(s.dir),await whole(cliRoot));
  assert.ok(s.calls.includes('POST /api/v1/apps/a_new/releases'));
 }finally{await s.close();}
});
test('CF-33 a start that fails while copying the template finishes on rerun and keeps the files changed in between',async()=>{
 const s=await setupSpace(),tool=join(s.root,'tool'),broken=join(tool,'templates/demo/interrupt'),changed=['AGENTS.md','app/server.mjs','package.json','.claude/skills/pneuma-space/SKILL.md'];try{
  await cp(cliRoot,tool,{recursive:true});await symlink(join(s.root,'missing'),broken);
  await assert.rejects(s.cli('start',{tool}),/ENOENT/);
  await rm(broken);
  for(const file of changed){await mkdir(dirname(join(s.dir,file)),{recursive:true});await writeFile(join(s.dir,file),'Changed by the person.\n');}
  await s.cli('start',{tool});
  assert.deepEqual(await projectFiles(s.dir),await whole(tool));
  for(const file of changed)assert.equal(await readFile(join(s.dir,file),'utf8'),'Changed by the person.\n');
  assert.ok(s.calls.includes('POST /api/v1/apps/a_new/releases'));
 }finally{await s.close();}
});
test('CF-33 start finishes a directory whose setup stopped with only its setup state',async t=>{
 const credentials={origin:'https://space.test',token:setupToken},states:Record<string,Record<string,unknown>>={
  'after the state folder':{'credentials.json':credentials},
  'after project.json, as an earlier CLI left it':{'credentials.json':credentials,'project.json':{name:'demo',tenant:'t',origin:'https://space.test',createKey:'k'}},
 };
 for(const [stopped,state] of Object.entries(states))await t.test(stopped,async()=>{
  const s=await setupSpace();try{
   await mkdir(join(s.dir,'.pneuma-space'),{recursive:true});
   for(const [file,value] of Object.entries(state))await writeFile(join(s.dir,'.pneuma-space',file),JSON.stringify(value));
   await s.cli('start');
   assert.deepEqual(await projectFiles(s.dir),await whole(cliRoot));
   assert.ok(s.calls.includes('POST /api/v1/apps/a_new/releases'));
  }finally{await s.close();}
 });
});
test('CF-33 init refuses a non-empty directory without setup state and changes nothing',async()=>{
 const s=await setupSpace();try{
  await mkdir(s.dir);await writeFile(join(s.dir,'notes.txt'),'Mine.\n');
  await assert.rejects(s.cli('init'),/not empty/);
  assert.deepEqual(await files(s.dir),['notes.txt']);assert.equal(await readFile(join(s.dir,'notes.txt'),'utf8'),'Mine.\n');
 }finally{await s.close();}
});
test('CF-33 init sets up a whole project on each Node release line the CLI admits that npx has cached',async t=>{
 const minimum=Number(/\d+/.exec(JSON.parse(await readFile(join(cliRoot,'package.json'),'utf8')).engines.node)![0]);
 for(let major=minimum;major<=Number(process.versions.node.split('.')[0]);major++)await t.test('node@'+major,async t=>{
  const node=await run('npx',['--offline','--yes','node@'+major,'-p','process.execPath']).then(result=>result.stdout.trim(),()=>null);
  if(!node)return t.skip('not in the npx cache; run npx --yes node@'+major+' -v once to include it');
  const s=await setupSpace();try{
   await s.cli('init',{node});
   assert.deepEqual(await projectFiles(s.dir),await whole(cliRoot));
  }finally{await s.close();}
 });
});
