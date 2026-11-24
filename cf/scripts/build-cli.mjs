import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../cli/',import.meta.url)),out=fileURLToPath(new URL('../public/downloads/',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'pneuma-space-pack-'));
try{
 const result=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:root,encoding:'utf8'}))[0];
 const bytes=await readFile(join(temp,result.filename)),sha256=createHash('sha256').update(bytes).digest('hex'),file=`pneuma-space-cli-${result.version}-${sha256.slice(0,12)}.tgz`;
 await mkdir(out,{recursive:true});await writeFile(join(out,file),bytes);
 await writeFile(join(out,'cli.json'),JSON.stringify({version:result.version,path:'/downloads/'+file,sha256,bytes:bytes.length})+'\n');
 console.log('Prepared public CLI '+file+' ('+bytes.length+' bytes)');
}finally{await rm(temp,{recursive:true,force:true});}
