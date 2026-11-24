#!/usr/bin/env node
import {readFile,writeFile,mkdir,readdir,lstat,cp,chmod,realpath} from 'node:fs/promises';
import {resolve,join,basename,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const toolRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const log=(step,message)=>console.log(`[${step}] ${message}`);
async function jsonFile(path){return JSON.parse(await readFile(path,'utf8'));}
async function save(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(path,0o600);}
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function packageApp(directory){
  const manifest=await jsonFile(join(directory,'pneuma-space.json')),files=[];
  async function walk(dir,prefix=''){
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=prefix+entry.name,full=join(dir,entry.name),info=await lstat(full);
      if(info.isSymbolicLink())throw Error('Application files must not be symlinks: '+path);
      if(entry.name.startsWith('.')||entry.name==='node_modules'||/^(AGENTS|CLAUDE|GEMINI)\.md$/.test(entry.name)||/\.(?:pem|key)$/.test(entry.name))throw Error('Keep credentials, instructions and development files outside app/: '+path);
      if(info.isDirectory())await walk(full,path+'/');
      else if(info.isFile()){
        if(info.size>3*1024*1024)throw Error('File is too large: '+path);
        files.push({path,body:(await readFile(full)).toString('base64'),contentType:mime[extname(path)]||'application/octet-stream'});
      }
    }
  }
  const source=await lstat(join(directory,'app'));
  if(!source.isDirectory()||source.isSymbolicLink())throw Error('app/ must be a real directory, not a symlink.');
  await walk(join(directory,'app'));
  if(!files.length||files.length>256)throw Error('Use one to 256 application files.');
  if(!files.some(file=>file.path===manifest.entry))throw Error('The manifest entry is missing from app/.');
  const bytes=Buffer.from(JSON.stringify({manifest,files}));
  if(bytes.length>4*1024*1024)throw Error('The application package exceeds 4 MiB. Bundle dependencies and remove unused files.');
  return {manifest,bytes,digest:digest(bytes)};
}
function apiClient(credentials){
  const origin=new URL(credentials.origin).origin;
  if(!origin.startsWith('https://'))throw Error('The workspace address must use HTTPS.');
  if(!/^[a-f0-9]{64}$/.test(credentials.token||''))throw Error('A publishing token is required. Create one in Dashboard → Create app.');
  const request=async(path,body,method=body===undefined?'GET':'POST',key=randomUUID())=>{
    const response=await fetch(origin+'/api/v1'+path,{method,headers:{authorization:'Bearer '+credentials.token,'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(180000)});
    const value=response.status===204?null:await response.json();
    if(!response.ok){const hint=response.status===401?' Create a fresh token in Dashboard → Create app.':'';throw Object.assign(Error((value?.error?.message||'Request failed')+hint),{status:response.status,code:value?.error?.code});}
    return value;
  };
  return {origin,request,headers:{authorization:'Bearer '+credentials.token}};
}
async function workspace(directory){
  const privateDir=join(directory,'.pneuma-space');
  return {directory,privateDir,project:await jsonFile(join(privateDir,'project.json')),client:apiClient(await jsonFile(join(privateDir,'credentials.json')))};
}
async function saveProject(w){await save(join(w.privateDir,'project.json'),w.project);}
export async function initialize(directory,options={}){
  const privateDir=join(directory,'.pneuma-space'),projectFile=join(privateDir,'project.json');
  if(await exists(projectFile)){
    const old=await jsonFile(projectFile);
    if(options.origin&&new URL(options.origin).origin!==old.origin||options.tenant&&options.tenant!==old.tenant)throw Error('This directory belongs to a different workspace. Choose a new directory.');
    if(process.env.PNEUMA_SPACE_TOKEN)await save(join(privateDir,'credentials.json'),{origin:old.origin,token:process.env.PNEUMA_SPACE_TOKEN});
    delete process.env.PNEUMA_SPACE_TOKEN;
    log('setup','Existing project retained. Continuing without replacing your files.');return workspace(directory);
  }
  if(await exists(directory)&&(await readdir(directory)).length)throw Error('The directory is not empty. Choose a new project directory; no files were replaced.');
  const name=options.name||basename(directory);
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(name))throw Error('Choose a project name with lowercase letters, digits and hyphens, starting with a letter.');
  if(!options.origin)throw Error('Use the complete command from Dashboard → Create app. The workspace address is missing.');
  const client=apiClient({origin:options.origin,token:process.env.PNEUMA_SPACE_TOKEN});
  const me=await client.request('/me');
  const tenant=options.tenant||me.tenants[0]?.id;
  if(!me.tenants.some(t=>t.id===tenant))throw Error('The token does not belong to this workspace.');
  await mkdir(privateDir,{recursive:true,mode:0o700});
  await save(join(privateDir,'credentials.json'),{origin:client.origin,token:process.env.PNEUMA_SPACE_TOKEN});delete process.env.PNEUMA_SPACE_TOKEN;
  const project={name,tenant,origin:client.origin,createKey:randomUUID()};
  await save(projectFile,project);
  await cp(join(toolRoot,'templates','demo'),directory,{recursive:true,force:false,errorOnExist:true});
  await cp(toolRoot,join(privateDir,'tool'),{recursive:true});
  const skill=await readFile(join(toolRoot,'templates','skill','SKILL.md'),'utf8');
  for(const folder of ['.agents','.claude','.cursor','.gemini','.github']){
    const target=join(directory,folder,'skills','pneuma-space');await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),skill);
    await cp(join(toolRoot,'templates','skill','references'),join(target,'references'),{recursive:true});
  }
  for(const file of ['CLAUDE.md','GEMINI.md','.github/copilot-instructions.md'])await writeFile(join(directory,file),'Read AGENTS.md before changing or deploying this application.\n');
  await writeFile(join(directory,'.gitignore'),'.pneuma-space/\nnode_modules/\n.env\n.env.*\n*.key\n*.pem\n');
  await writeFile(join(directory,'package.json'),JSON.stringify({name,private:true,type:'module',scripts:{deploy:'node .pneuma-space/tool/bin/pneuma-space.mjs publish',bench:'node .pneuma-space/tool/bin/pneuma-space.mjs bench',status:'node .pneuma-space/tool/bin/pneuma-space.mjs status'}},null,2)+'\n');
  log('setup',`Created ${directory}. Project instructions and skills are installed for Codex, Claude Code, Cursor, Gemini CLI and Copilot.`);
  return workspace(directory);
}
const appUrl=w=>w.client.origin+'/apps/'+w.project.app.name+'/';
export async function publish(w){
  const {project,client}=w,packed=await packageApp(w.directory);
  if(!project.app){
    project.app=await client.request('/tenants/'+project.tenant+'/apps',{name:project.name},'POST',project.createKey);await saveProject(w);
  }
  const path='/apps/'+project.app.id;
  if(project.publishedDigest===packed.digest){
    const snapshot=await client.request(path);
    if(snapshot.status==='registered'&&snapshot.current?.digest===packed.digest){log('publish','This exact version is already live.');return snapshot;}
  }
  if(!project.upload||project.upload.digest!==packed.digest||project.upload.expiresAt<Date.now()+15000){
    const ticket=await client.request(path+'/uploads',{manifest:packed.manifest,digest:packed.digest,bytes:packed.bytes.length});
    project.upload={...ticket,digest:packed.digest,publishKey:randomUUID()};await saveProject(w);
  }
  const ticket=project.upload;
  log('publish',`Uploading ${(packed.bytes.length/1024).toFixed(1)} KiB directly to storage.`);
  const put=await fetch(ticket.url,{method:'PUT',headers:ticket.headers,body:packed.bytes,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!put.ok){await put.body?.cancel();throw Error('Direct upload failed ('+put.status+'). Run npm run deploy to retry.');}await put.body?.cancel();
  const snapshot=await client.request(path+'/releases',{uploadId:ticket.uploadId},'POST',ticket.publishKey);
  project.publishedDigest=packed.digest;project.upload=null;await saveProject(w);
  log('publish',`Release ${snapshot.current.number} is live: ${appUrl(w)}`);return snapshot;
}
export async function benchmark(w,{awaitIdle=true}={}){
  const {project,client}=w;if(!project.app)throw Error('Publish the project first with npm run deploy.');
  const path='/apps/'+project.app.id,before=await client.request(path);
  if(before.current?.manifest.runtime!=='node')throw Error('The idle/wake benchmark requires a Node application.');
  const call=async(method='GET',body)=>{
    const start=performance.now();const r=await fetch(appUrl(w)+'api/proof',{method,headers:{...client.headers,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(60000)});
    const value=await r.json();if(!r.ok)throw Error('The benchmark probe failed ('+r.status+'). Keep the starter /api/proof endpoint or adapt it to your app.');
    if(typeof value.boot!=='string')throw Error('The benchmark probe must return its process boot identifier.');
    return {ms:Math.round(performance.now()-start),...value};
  };
  log('bench','Checking a saved marker and warm requests. Times include your network.');
  const marker=randomUUID(),first=await call('POST',{marker}),warm=[];
  for(let i=0;i<5;i++)warm.push((await call()).ms);
  const dashboard=client.origin+'/dashboard?view=projects&app='+project.app.id+'&tab=usage',sorted=[...warm].sort((a,b)=>a-b);
  const timings={firstRequestMs:first.ms,warmMedianMs:sorted[Math.floor(sorted.length/2)],warmP95Ms:sorted.at(-1),warmSamplesMs:warm};
  const waitSeconds=before.policy.idleSeconds+90,links=()=>{log('ready','Open your app: '+appUrl(w));log('access','Use the browser where you are signed into '+client.origin+'. This app is private; a publishing token does not replace browser login.');log('stats','See real requests and wake/sleep counts: '+dashboard);};
  if(!awaitIdle){
    const after=await client.request(path);
    const report={complete:false,reason:`Natural idle was not awaited. npm run bench waits for it, up to ${waitSeconds}s under this app's policy.`,at:new Date().toISOString(),appId:project.app.id,app:appUrl(w),dashboard,...timings,naturalIdleObserved:false,before:before.usage,after:after.usage};
    await save(join(w.privateDir,'bench.json'),report);
    console.log(JSON.stringify(report,null,2));
    links();
    log('idle',`Sleep and recovery are not verified yet. Run npm run bench while the app is closed; it waits up to ${waitSeconds}s.`);
    return report;
  }
  log('bench',`Waiting for natural idle (${before.policy.idleSeconds}s policy, up to ${waitSeconds}s). Keep the app tab closed for this check.`);
  const idleStart=Date.now(),deadline=idleStart+waitSeconds*1000;let slept=null;
  while(Date.now()<deadline){
    await delay(3000);const snapshot=await client.request(path);
    if(snapshot.runtime.state==='asleep'&&!snapshot.runtime.running){slept=snapshot;break;}
  }
  if(!slept){const report={complete:false,reason:'Other traffic or active leases prevented natural idle.',app:appUrl(w),dashboard};await save(join(w.privateDir,'bench.json'),report);throw Error('Idle was not observed. Close app tabs and run npm run bench again. See '+dashboard);}
  log('bench','The runtime stopped naturally. Visiting it again now.');
  const resumed=await call();
  if(resumed.boot===first.boot)throw Error('The probe returned the same process boot; automatic restart is not verified.');
  if(resumed.marker!==marker)throw Error('The saved marker did not survive idle.');
  const after=await client.request(path);
  const report={complete:true,at:new Date().toISOString(),appId:project.app.id,app:appUrl(w),dashboard,initialState:before.runtime.state,...timings,naturalIdleObserved:true,idleObservedAfterMs:Date.now()-idleStart-resumed.ms,wakeRequestMs:resumed.ms,newBoot:true,dataRetained:true,before:before.usage,after:after.usage,delta:Object.fromEntries(['requests','errors','wakes','sleeps'].map(key=>[key,after.usage[key]-before.usage[key]]))};
  await save(join(w.privateDir,'bench.json'),report);
  console.log(JSON.stringify(report,null,2));
  links();
  return report;
}
async function main(){
  const [command='help',...args]=process.argv.slice(2),options={},pos=[];
  for(let i=0;i<args.length;i++){if(args[i]==='--token-stdin'){options.tokenStdin=true;continue;}if(args[i].startsWith('--')){const key=args[i].slice(2);if(!['origin','tenant','name'].includes(key)||!args[i+1])throw Error('Unknown or incomplete option: '+args[i]);options[key]=args[++i];}else pos.push(args[i]);}
  if(['help','--help','-h'].includes(command)){console.log('PneumaSpace\n  start DIRECTORY --origin URL [--tenant ID]   Scaffold, publish and measure requests; natural idle is left to bench\n  init DIRECTORY --origin URL [--tenant ID]    Scaffold without publishing\n  publish [DIRECTORY]                         Publish app/ with your saved token\n  bench [DIRECTORY]                           Verify warm requests, natural idle and retained state\n  status [DIRECTORY]                          Inspect real runtime and usage\n  package [DIRECTORY]                         Validate files without publishing\nToken: PNEUMA_SPACE_TOKEN from Dashboard → Create app. Node 22+ required.');return;}
  if(!['start','init','publish','bench','status','package'].includes(command))throw Error('Unknown command. Run pneuma-space help.');
  if(['start','init'].includes(command)&&!pos[0])throw Error('Choose a new project directory.');
  if(options.tokenStdin){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>256)throw Error('Invalid token input.');}process.env.PNEUMA_SPACE_TOKEN=value.trim();}
  const directory=resolve(pos[0]||'.');
  if(command==='package'){const packed=await packageApp(directory);console.log(JSON.stringify({bytes:packed.bytes.length,digest:packed.digest}));return;}
  const w=['start','init'].includes(command)?await initialize(directory,options):await workspace(directory);
  if(command==='init'){log('next',`Read ${join(directory,'AGENTS.md')}. Edit app/, then run npm run deploy and npm run bench in this directory.`);return;}
  if(['start','publish'].includes(command))await publish(w);
  if(['start','bench'].includes(command))await benchmark(w,{awaitIdle:command==='bench'});
  if(command==='status')console.log(JSON.stringify(await w.client.request('/apps/'+w.project.app.id),null,2));
}
if(process.argv[1]&&await realpath(resolve(process.argv[1]))===fileURLToPath(import.meta.url))main().catch(error=>{console.error('PneumaSpace: '+error.message);process.exitCode=1;});
