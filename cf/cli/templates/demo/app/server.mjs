import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const boot=randomUUID(),startedAt=Date.now();
const assets=new Map(await Promise.all([['/','index.html','text/html; charset=utf-8'],['/style.css','style.css','text/css'],['/app.js','app.js','text/javascript']].map(async([url,file,type])=>[url,{body:await readFile(new URL(file,import.meta.url)),type}])));
const seed=[
  {id:'first-screen',title:'The one-screen project',note:'A small tool for one everyday problem. What would you build if it had only one screen?',category:'Ideas',url:'',pinned:true,archived:false},
  {id:'slow-reading',title:'A slower way to read',note:'Keep one article open. Save one useful sentence. Close the rest. A little intention goes a long way.',category:'Reading',url:'https://developer.mozilla.org/en-US/docs/Learn_web_development',pinned:false,archived:false},
  {id:'saturday',title:'A Saturday without a plan',note:'Walk somewhere new. Find a bookshop. Leave room for a good coffee. This is a sample entry; make it your own.',category:'Life',url:'',pinned:false,archived:false},
  {id:'future-you',title:'Leave a note for future you',note:'Save why a link matters, not just where it goes. Your future self will appreciate the context.',category:'Reading',url:'',pinned:false,archived:false},
];
async function native(command){const r=await fetch('http://pneuma-space.internal/broker',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error?.message||'Storage unavailable'),{status:r.status});return value;}
async function input(req){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Object.assign(Error('Keep your shelf under16 KiB.'),{status:413});}try{return JSON.parse(raw||'{}');}catch{throw Object.assign(Error('Invalid request.'),{status:400});}}
function validate(items){
  if(!Array.isArray(items)||items.length>24)throw Object.assign(Error('This little shelf holds up to24 entries.'),{status:400});
  const ids=new Set();
  return items.map(item=>{
    if(!item||typeof item.id!=='string'||!/^[a-zA-Z0-9-]{1,60}$/.test(item.id)||ids.has(item.id)||typeof item.title!=='string'||!item.title.trim()||item.title.length>80||typeof item.note!=='string'||item.note.length>400||!['Ideas','Reading','Life'].includes(item.category)||typeof item.url!=='string'||item.url.length>500||item.url&&!/^https?:\/\//.test(item.url)||typeof item.pinned!=='boolean'||typeof item.archived!=='boolean')throw Object.assign(Error('Check the entry title, note and link.'),{status:400});
    ids.add(item.id);return {id:item.id,title:item.title.trim(),note:item.note,category:item.category,url:item.url,pinned:item.pinned,archived:item.archived};
  });
}
http.createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
    const path=new URL(req.url,'http://app').pathname,asset=assets.get(path);
    if(req.method==='GET'&&asset){res.writeHead(200,{'content-type':asset.type,'cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(asset.body);return;}
    if(path==='/api/proof'){
      if(req.method==='POST'){const body=await input(req);if(typeof body.marker!=='string'||body.marker.length>100)return json({error:'Invalid proof'},400);await native({type:'kv.put',key:'demo:proof',value:body.marker});}
      else if(req.method!=='GET')return json({error:'Method not allowed'},405);
      return json({boot,startedAt,marker:(await native({type:'kv.get',key:'demo:proof'}))?.value??null});
    }
    if(path==='/api/items'&&req.method==='GET'){const saved=await native({type:'kv.get',key:'shelf:items'});return json({items:saved?.value??seed,revision:saved?.revision??null,sample:!saved,startedAt});}
    if(path==='/api/items'&&req.method==='PUT'){
      const body=await input(req);if(body.revision!==null&&!Number.isSafeInteger(body.revision))return json({error:'Reload your shelf before saving.'},400);
      const items=validate(body.items),saved=await native({type:'kv.put',key:'shelf:items',value:items,expected:body.revision});return json({items,revision:saved.revision,sample:false,startedAt});
    }
    json({error:'Not found'},404);
  }catch(error){json({error:error.status===409?'Your shelf changed in another tab. Reload before saving.':error.status?error.message:'Could not save right now. Please try again.'},error.status||500);}
}).listen(Number(process.env.PNEUMA_SPACE_PORT),'0.0.0.0');
