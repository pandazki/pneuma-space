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
 try{const bin=join(dir,'pneuma-space');await symlink(cli,bin);const output=execFileSync(process.execPath,[bin,'help'],{encoding:'utf8'});assert.match(output,/Scaffold, publish and verify natural idle/);}finally{await rm(dir,{recursive:true,force:true});}
});
