#!/usr/bin/env node
import {readFile,writeFile,mkdir,readdir,lstat,copyFile,chmod,realpath,constants} from 'node:fs/promises';
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
  // A job is declared once, as a trigger in the manifest the platform reads, and run by app/jobs/<name>.mjs; neither may lack the other.
  const declared=Object.keys(manifest.capabilities?.cron?.triggers??{}),handled=files.map(file=>/^jobs\/([^/]+)\.mjs$/.exec(file.path)?.[1]).filter(Boolean);
  for(const name of declared)if(!handled.includes(name))throw Error(`pneuma-space.json declares the job ${name}, but app/jobs/${name}.mjs is missing.`);
  for(const name of handled)if(!declared.includes(name))throw Error(`app/jobs/${name}.mjs is not declared. Add "${name}":{"schedule":"MINUTE HOUR DAY MONTH WEEKDAY"} (UTC), or "${name}":{} to run it only on demand, under capabilities.cron.triggers in pneuma-space.json. Every .mjs file directly in app/jobs/ is a job; keep shared code elsewhere.`);
  const bytes=Buffer.from(JSON.stringify({manifest,files}));
  if(bytes.length>4*1024*1024)throw Error('The application package exceeds 4 MiB. Bundle dependencies and remove unused files.');
  return {manifest,bytes,digest:digest(bytes)};
}
function apiClient(credentials){
  const origin=new URL(credentials.origin).origin;
  if(!origin.startsWith('https://'))throw Error('The workspace address must use HTTPS.');
  if(!/^[a-f0-9]{64}$/.test(credentials.token||''))throw Error('A publishing token is required. Create one in Dashboard → Create app.');
  const request=async(path,body,method=body===undefined?'GET':'POST',key=randomUUID(),headers={})=>{
    const response=await fetch(origin+'/api/v1'+path,{method,headers:{...headers,authorization:'Bearer '+credentials.token,'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(180000)});
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
const keepExisting=error=>{if(error.code!=='EEXIST')throw error;};
const create=(path,text)=>writeFile(path,text,{flag:'wx'}).catch(keepExisting);
async function copyTree(from,to,{replace=false}={}){
  await mkdir(to,{recursive:true});
  for(const entry of await readdir(from,{withFileTypes:true})){
    const source=join(from,entry.name),target=join(to,entry.name);
    if(entry.isDirectory())await copyTree(source,target,{replace});
    else await copyFile(source,target,replace?0:constants.COPYFILE_EXCL).catch(keepExisting);
  }
}
// Each step keeps the files that exist, so running it again finishes whatever an earlier run left; setup:'complete' comes last.
async function scaffold(directory,project){
  const privateDir=join(directory,'.pneuma-space');
  await copyTree(join(toolRoot,'templates','demo'),directory);
  await copyTree(toolRoot,join(privateDir,'tool'),{replace:true});
  for(const folder of ['.agents','.claude','.cursor','.gemini','.github'])await copyTree(join(toolRoot,'templates','skill'),join(directory,folder,'skills','pneuma-space'));
  for(const file of ['CLAUDE.md','GEMINI.md','.github/copilot-instructions.md'])await create(join(directory,file),'Read AGENTS.md before changing or deploying this application.\n');
  await create(join(directory,'.gitignore'),'.pneuma-space/\nnode_modules/\n.env\n.env.*\n*.key\n*.pem\n');
  await create(join(directory,'package.json'),JSON.stringify({name:project.name,private:true,type:'module',scripts:{deploy:'node .pneuma-space/tool/bin/pneuma-space.mjs publish',bench:'node .pneuma-space/tool/bin/pneuma-space.mjs bench',status:'node .pneuma-space/tool/bin/pneuma-space.mjs status'}},null,2)+'\n');
  await save(join(privateDir,'project.json'),{...project,setup:'complete'});
  log('setup',`Created ${directory}. Project instructions and skills are installed for Codex, Claude Code, Cursor, Gemini CLI and Copilot.`);
  return workspace(directory);
}
export async function initialize(directory,options={}){
  const privateDir=join(directory,'.pneuma-space'),projectFile=join(privateDir,'project.json');
  if(await exists(projectFile)){
    const old=await jsonFile(projectFile);
    if(options.origin&&new URL(options.origin).origin!==old.origin||options.tenant&&options.tenant!==old.tenant)throw Error('This directory belongs to a different workspace. Choose a new directory.');
    if(process.env.PNEUMA_SPACE_TOKEN)await save(join(privateDir,'credentials.json'),{origin:old.origin,token:process.env.PNEUMA_SPACE_TOKEN});
    delete process.env.PNEUMA_SPACE_TOKEN;
    // An earlier CLI wrote no marker. Its project got past setup once publish had created an app, which leaves an app key, null after a discard.
    if(old.setup!=='complete'){
      if(!('app' in old)){log('setup','Finishing an interrupted setup. Files that already exist are kept.');return scaffold(directory,old);}
      await save(projectFile,{...old,setup:'complete'});
    }
    log('setup','Existing project retained. Continuing without replacing your files.');return workspace(directory);
  }
  if(await exists(directory)&&(await readdir(directory)).some(name=>name!=='.pneuma-space'))throw Error('The directory is not empty. Choose a new project directory; no files were replaced.');
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
  return scaffold(directory,project);
}
const appUrl=w=>w.client.origin+'/apps/'+w.project.app.name+'/';
// --manager names the manager on each write and, on publish, also sets it (ADR 0039).
const named=options=>options.manager?{'x-pneuma-space-manager':options.manager}:{};
const managed=options=>options.manager?{manager:{name:options.manager,...(options['manager-url']!==undefined&&{url:options['manager-url']})}}:{};
const forget=project=>Object.assign(project,{app:null,publishedDigest:null,upload:null,createKey:randomUUID()});
export async function publish(w,options={}){
  const {project,client}=w,packed=await packageApp(w.directory),ephemeral=options.ephemeral?{ephemeral:true}:{};
  if(project.app?.expiresAt&&project.app.expiresAt<=Date.now()){log('publish',`The ephemeral app ${project.app.id} ended at ${new Date(project.app.expiresAt).toISOString()}; publishing creates a new one.`);forget(project);}
  if(!project.app){
    project.app=await client.request('/tenants/'+project.tenant+'/apps',{name:project.name,...(options.ephemeral&&{ephemeral:options.ttl?{ttlSeconds:Number(options.ttl)}:{}}),...managed(options)},'POST',project.createKey);await saveProject(w);
  }
  const path='/apps/'+project.app.id;
  if(project.publishedDigest===packed.digest&&!options.manager){
    const snapshot=await client.request(path);
    if(snapshot.status==='registered'&&snapshot.current?.digest===packed.digest){log('publish','This exact version is already live.');return snapshot;}
  }
  if(!project.upload||project.upload.digest!==packed.digest||project.upload.expiresAt<Date.now()+15000){
    const ticket=await client.request(path+'/uploads',{manifest:packed.manifest,digest:packed.digest,bytes:packed.bytes.length,...ephemeral},'POST',undefined,named(options));
    project.upload={...ticket,digest:packed.digest,publishKey:randomUUID()};await saveProject(w);
  }
  const ticket=project.upload;
  log('publish',`Uploading ${(packed.bytes.length/1024).toFixed(1)} KiB directly to storage.`);
  const put=await fetch(ticket.url,{method:'PUT',headers:ticket.headers,body:packed.bytes,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!put.ok){await put.body?.cancel();throw Error('Direct upload failed ('+put.status+'). Run npm run deploy to retry.');}await put.body?.cancel();
  const snapshot=await client.request(path+'/releases',{uploadId:ticket.uploadId,...ephemeral,...managed(options)},'POST',ticket.publishKey,named(options));
  project.publishedDigest=packed.digest;project.upload=null;await saveProject(w);
  log('publish',`Release ${snapshot.current.number} of app ${snapshot.id} is live: ${appUrl(w)}`);
  if(snapshot.expiresAt!==null)log('publish',`This ephemeral app ends at ${new Date(snapshot.expiresAt).toISOString()}.`);
  return snapshot;
}
export async function discard(w,options={}){
  const id=options.app||w.project.app?.id;
  if(!id)throw Error('Nothing to discard: this project has no app yet.');
  const result=await w.client.request('/apps/'+id+'/actions',{type:'discard'},'POST',undefined,named(options));
  if(id===w.project.app?.id){forget(w.project);await saveProject(w);}
  log('discard',result.pending?`App ${id} is ending; its last cleanup waits until ${new Date(result.retryAt).toISOString()}.`:`App ${id} is discarded; its data is deleted.`);
  return result;
}
export async function unmanage(w,options={}){
  if(!w.project.app)throw Error('This project has no app yet.');
  await w.client.request('/apps/'+w.project.app.id+'/manager',undefined,'DELETE',undefined,named(options));
  log('unmanage',`App ${w.project.app.id} has no manager.`);
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
  const waitSeconds=before.policy.idleSeconds+90,links=()=>{log('ready','Open your app: '+appUrl(w));log('access','The app is private. A person opens it in a browser signed into '+client.origin+'; from this project, the get command requests its pages with the saved token.');log('stats','See real requests and wake/sleep counts: '+dashboard);};
  if(!awaitIdle){
    const after=await client.request(path);
    const report={complete:false,reason:`Natural idle was not awaited. npm run bench waits for it, up to ${waitSeconds}s under this app's policy.`,at:new Date().toISOString(),appId:project.app.id,app:appUrl(w),dashboard,...timings,wake:after.wake,naturalIdleObserved:false,before:before.usage,after:after.usage};
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
  const report={complete:true,at:new Date().toISOString(),appId:project.app.id,app:appUrl(w),dashboard,initialState:before.runtime.state,...timings,naturalIdleObserved:true,idleObservedAfterMs:Date.now()-idleStart-resumed.ms,wakeRequestMs:resumed.ms,wake:after.wake,newBoot:true,dataRetained:true,before:before.usage,after:after.usage,delta:Object.fromEntries(['requests','errors','wakes','sleeps'].map(key=>[key,after.usage[key]-before.usage[key]]))};
  await save(join(w.privateDir,'bench.json'),report);
  console.log(JSON.stringify(report,null,2));
  links();
  return report;
}
const live=w=>{if(!w.project.app)throw Error('Publish the project first with npm run deploy.');return '/apps/'+w.project.app.id;};
const utc=at=>new Date(at).toISOString().replace(/\.\d{3}Z$/,'Z');
const latest=(items,count,key)=>[...items].sort((a,b)=>a[key]-b[key]).slice(-count);
async function output(w,since,count){
  const lines=latest((await w.client.request(live(w)+'/logs')).items.filter(row=>row.at>=since),count,'at').map(row=>utc(row.at)+'  '+row.level+'  '+row.message.slice(0,300));
  return lines.length?'App output (UTC):\n'+lines.join('\n'):'No app output.';
}
export async function runJobNow(w,name,{interval=1000,timeout=180000}={}){
  const path=live(w),since=Date.now();let job;
  try{job=await w.client.request(path+'/jobs',{name,payload:null});}
  catch(error){
    if(error.code==='token_scope')throw Error('This token cannot run jobs on demand: that needs the manage permission, which the token from Dashboard → Create app does not include. Scheduled deliveries still run; follow them with the jobs command.');
    if(error.code==='trigger'||error.code==='capability')throw Error(`The live release has no job ${name}. Declare it in pneuma-space.json, write app/jobs/${name}.mjs and run npm run deploy.`);
    throw error;
  }
  log('run',`Delivery ${job.id} of ${name} is queued; waiting for the app to run it.`);
  let settled=false;
  for(const deadline=Date.now()+timeout;!settled&&Date.now()<deadline;){
    await delay(interval);
    job=(await w.client.request(path+'/jobs')).items.find(item=>item.id===job.id)??job;
    settled=job.state==='done'||job.state==='failed'||job.state==='cancelled'||job.error!==null;
  }
  if(job.state==='done')log('run',`${name} finished delivery ${job.id} on attempt ${job.attempts}.`);
  else if(job.state==='due'&&job.error)log('run',`Attempt ${job.attempts} of ${name} failed: ${job.error}. The platform retries it, up to 5 attempts; follow it with the jobs command.`);
  else log('run',`Delivery ${job.id} of ${name} is ${job.state} after attempt ${job.attempts}${job.error?': '+job.error:''}.`);
  if(job.state!=='done')process.exitCode=1;
  await delay(interval);
  console.log(await output(w,since,20));
  return job;
}
export async function showJobs(w){
  const path=live(w),[app,jobs]=await Promise.all([w.client.request(path),w.client.request(path+'/jobs')]);
  const triggers=Object.entries(app.current?.manifest.capabilities.cron?.triggers??{}),last=latest(jobs.items,10,'scheduledFor').reverse();
  console.log(triggers.length?'Jobs in the live release, schedules in UTC:\n'+triggers.map(([name,trigger])=>'  '+name+'  '+(trigger.schedule??'on demand only')).join('\n'):'The live release declares no jobs.');
  if(triggers.length&&app.expiresAt!==null)console.log('This app is ephemeral: its schedules never fire. The run command still runs a job.');
  console.log(last.length?`Last ${last.length} of ${jobs.items.length} deliveries, newest first:\n`+last.map(job=>`  ${utc(job.scheduledFor)}  ${job.name}  ${job.state}  attempts ${job.attempts}  ${job.id}${job.error?'  '+job.error.slice(0,200):''}`).join('\n'):'No deliveries yet.');
  console.log(await output(w,0,20));
}
// The project's token reaches its own app as a Bearer credential. Only GET: the app's stored data is the user's real data.
export async function getPath(w,path){
  live(w);
  const base=appUrl(w),url=new URL(path.replace(/^\/+/,''),base);
  if(!url.href.startsWith(base))throw Error('Choose a path inside this app, such as / or api/items.');
  const response=await fetch(url,{headers:w.client.headers,redirect:'manual',signal:AbortSignal.timeout(60000)});
  const body=Buffer.from(await response.arrayBuffer()),type=response.headers.get('content-type')||'';
  log('get',`GET ${url.pathname}${url.search}: ${response.status}, ${type||'no content type'}, ${body.length} bytes`);
  console.log(/^text\/|json|javascript|xml/.test(type)?body.subarray(0,2000).toString('utf8')+(body.length>2000?'\n[first 2000 of '+body.length+' bytes]':''):`[${body.length} bytes not shown]`);
  if(!response.ok)process.exitCode=1;
  return response.status;
}
async function main(){
  const [command='help',...args]=process.argv.slice(2),options={},pos=[];
  for(let i=0;i<args.length;i++){if(args[i]==='--token-stdin'){options.tokenStdin=true;continue;}if(args[i]==='--ephemeral'){options.ephemeral=true;continue;}if(args[i].startsWith('--')){const key=args[i].slice(2);if(!['origin','tenant','name','ttl','manager','manager-url','app'].includes(key)||!args[i+1])throw Error('Unknown or incomplete option: '+args[i]);options[key]=args[++i];}else pos.push(args[i]);}
  if(options.ttl!==undefined&&(!options.ephemeral||!/^[1-9]\d*$/.test(options.ttl)))throw Error('--ttl takes whole seconds and needs --ephemeral.');
  if(options['manager-url']!==undefined&&!options.manager)throw Error('--manager-url needs --manager.');
  if(['help','--help','-h'].includes(command)){console.log('PneumaSpace\n  start DIRECTORY --origin URL [--tenant ID]   Scaffold, publish and measure requests; natural idle is left to bench\n  init DIRECTORY --origin URL [--tenant ID]    Scaffold without publishing\n  publish [DIRECTORY]                         Publish app/ with your saved token\n    --ephemeral [--ttl SECONDS]               A new app that ends by itself after SECONDS or the deployment default\n  discard [DIRECTORY] [--app ID]              End the ephemeral app of this project and delete its data\n  unmanage [DIRECTORY]                        Clear the manager of this app\n  bench [DIRECTORY]                           Verify warm requests, natural idle and retained state\n  --manager NAME [--manager-url URL]          Name the manager of a managed app on a write; publish also sets it\n  status [DIRECTORY]                          Inspect real runtime and usage\n  run JOB [DIRECTORY]                         Run a job of app/jobs now and print its outcome and the app output\n  jobs [DIRECTORY]                            List the declared jobs, the last 10 deliveries and the last 20 lines of app output\n  get PATH [DIRECTORY]                        GET a path of this app with the saved token; print the status and the start of the reply\n  package [DIRECTORY]                         Validate files without publishing\nToken: PNEUMA_SPACE_TOKEN from Dashboard → Create app. Node 22+ required.');return;}
  const view={run:runJobNow,get:getPath,jobs:showJobs}[command];
  if(view){const argument=['run','get'].includes(command)?pos.shift():null;if(argument===undefined)throw Error(command==='run'?'Name the job: run JOB [DIRECTORY].':'Name a path: get PATH [DIRECTORY], such as get / or get api/items.');await view(await workspace(resolve(pos[0]||'.')),argument);return;}
  if(!['start','init','publish','bench','status','package','discard','unmanage'].includes(command))throw Error('Unknown command. Run pneuma-space help.');
  if(['start','init'].includes(command)&&!pos[0])throw Error('Choose a new project directory.');
  if(options.tokenStdin){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>256)throw Error('Invalid token input.');}process.env.PNEUMA_SPACE_TOKEN=value.trim();}
  const directory=resolve(pos[0]||'.');
  if(command==='package'){const packed=await packageApp(directory);console.log(JSON.stringify({bytes:packed.bytes.length,digest:packed.digest}));return;}
  const w=['start','init'].includes(command)?await initialize(directory,options):await workspace(directory);
  if(command==='init'){log('next',`Read ${join(directory,'AGENTS.md')}. Edit app/, then run npm run deploy and npm run bench in this directory.`);return;}
  if(['start','publish'].includes(command))await publish(w,options);
  if(command==='discard')await discard(w,options);
  if(command==='unmanage')await unmanage(w,options);
  if(['start','bench'].includes(command))await benchmark(w,{awaitIdle:command==='bench'});
  if(command==='status')console.log(JSON.stringify(await w.client.request('/apps/'+w.project.app.id),null,2));
}
if(process.argv[1]&&await realpath(resolve(process.argv[1]))===fileURLToPath(import.meta.url))main().catch(error=>{console.error('PneumaSpace: '+error.message);process.exitCode=1;});
