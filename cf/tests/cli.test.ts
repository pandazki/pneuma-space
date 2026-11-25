import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
