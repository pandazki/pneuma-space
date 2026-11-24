'use strict';
const $=id=>document.getElementById(id),state={items:[],revision:null,loaded:false,opening:null,category:'All',archived:false,editing:null,busy:false,undo:null};
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,action,cls='quiet')=>{const b=node('button',label,cls);b.type='button';b.addEventListener('click',action);return b;};
function message(text,kind=''){$('message').hidden=!text;$('message').className='message'+(kind?' '+kind:'');$('message').textContent=text;}
function notice(text,kind,retry){message(text,kind);if(retry)$('message').append(button('Try again',load));}
async function load(){
 state.opening?.abort();const controller=state.opening=new AbortController();
 for(const card of document.querySelectorAll('.placeholder'))card.hidden=false;
 const slow=setTimeout(()=>notice('Waking your shelf. The first visit after a quiet spell takes a few seconds.','waiting',false),1500),stuck=setTimeout(()=>notice('Still waking your shelf.','waiting',true),10000);
 try{
  const r=await fetch('api/items',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])}),d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(typeof d.error==='string'?d.error:'Your shelf could not be opened right now.');
  Object.assign(state,{items:d.items,revision:d.revision,loaded:true});message('');$('new').disabled=false;$('shelf').removeAttribute('aria-busy');
  $('saved').textContent=d.sample?'Four sample entries. Edit them to make this shelf yours.':'Your shelf is saved. Come back whenever.';render();
 }catch(error){
  if(controller.signal.aborted)return;
  for(const card of document.querySelectorAll('.placeholder'))card.hidden=true;
  $('count').textContent='Your shelf did not open';notice(error.name==='TimeoutError'?'Your shelf took too long to open.':error instanceof TypeError?'Your shelf could not be reached.':error.message,'error',true);
 }finally{clearTimeout(slow);clearTimeout(stuck);}
}
async function save(items){
 if(state.busy)return false;state.busy=true;$('save').disabled=true;message('');
 try{const r=await fetch('api/items',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({items,revision:state.revision})});const d=await r.json();if(!r.ok)throw Error(d.error||'Please try saving again.');Object.assign(state,{items:d.items,revision:d.revision});$('saved').textContent='All changes saved. Your ideas will be here when you return.';render();return true;}
 catch(error){message(error.message,'error');throw error;}finally{state.busy=false;$('save').disabled=false;}
}
function edit(entry=null){state.editing=entry?.id??null;$('editor-title').textContent=entry?'A little edit':'Add to your shelf';$('title').value=entry?.title??'';$('note').value=entry?.note??'';$('url').value=entry?.url??'';$('category').value=entry?.category??'Ideas';$('delete').hidden=!entry;$('form-message').hidden=true;$('editor').showModal();$('title').focus();}
async function change(id,patch){try{await save(state.items.map(item=>item.id===id?{...item,...patch}:item));}catch{}}
function render(){
 if(!state.loaded)return;
 const query=$('search').value.trim().toLowerCase(),visible=state.items.filter(item=>item.archived===state.archived&&(state.category==='All'||item.category===state.category)&&(!query||`${item.title} ${item.note} ${item.url}`.toLowerCase().includes(query))).sort((a,b)=>Number(b.pinned)-Number(a.pinned));
 $('shelf').replaceChildren();$('count').textContent=`${visible.length} ${visible.length===1?'entry':'entries'}${state.archived?' in your archive':' on your shelf'}`;
 for(const entry of visible){
  const article=node('article',undefined,'entry'),top=node('div',undefined,'entry-top'),category=node('span',entry.category,'category '+entry.category.toLowerCase());
  const pin=button(entry.pinned?'◆':'◇',()=>change(entry.id,{pinned:!entry.pinned}),'pin');pin.setAttribute('aria-label',(entry.pinned?'Unpin ':'Pin ')+entry.title);pin.setAttribute('aria-pressed',String(entry.pinned));
  top.append(category,pin);article.append(top,node('h2',entry.title),node('p',entry.note));
  const bottom=node('div',undefined,'entry-bottom');if(entry.url){const a=node('a','Open page ↗','source');a.href=entry.url;a.target='_blank';a.rel='noopener noreferrer';bottom.append(a);}
  const actions=node('div',undefined,'actions');actions.append(button('Edit',()=>edit(entry)),button(entry.archived?'Restore':'Archive',()=>change(entry.id,{archived:!entry.archived})));bottom.append(actions);article.append(bottom);$('shelf').append(article);
 }
 if(!visible.length){const empty=node('div',undefined,'empty');empty.append(node('h2',query?'Nothing here just yet.':state.archived?'A quiet archive.':'Make a little space for an idea.'),node('p',query?'Try another word or collection.':state.archived?'Entries you archive will wait here.':'Add a thought, a link, or a small plan.'));if(!state.archived&&!query)empty.append(button('Add your first entry',()=>edit(),'primary'));$('shelf').append(empty);}
}
$('new').addEventListener('click',()=>edit());$('close').addEventListener('click',()=>$('editor').close());$('search').addEventListener('input',render);
for(const b of document.querySelectorAll('[data-category]'))b.addEventListener('click',()=>{state.category=b.dataset.category;for(const other of document.querySelectorAll('[data-category]'))other.setAttribute('aria-pressed',String(other===b));render();});
$('archive').addEventListener('click',()=>{state.archived=!state.archived;$('archive').setAttribute('aria-pressed',String(state.archived));$('archive').textContent=state.archived?'Back to shelf':'View archive';render();});
$('entry-form').addEventListener('submit',async e=>{e.preventDefault();if(state.busy)return;const old=state.items.find(i=>i.id===state.editing),entry={id:old?.id??crypto.randomUUID(),title:$('title').value,note:$('note').value,url:$('url').value.trim(),category:$('category').value,pinned:old?.pinned??false,archived:old?.archived??false};try{if(await save(old?state.items.map(i=>i.id===old.id?entry:i):[entry,...state.items]))$('editor').close();}catch(error){$('form-message').hidden=false;$('form-message').textContent=error.message;}});
$('delete').addEventListener('click',async()=>{if(state.busy)return;const old=[...state.items];try{if(await save(state.items.filter(i=>i.id!==state.editing))){$('editor').close();state.undo=old;message('Entry removed.');$('message').append(button('Undo',async()=>{try{if(state.undo&&await save(state.undo)){state.undo=null;message('Entry restored.');}}catch{}}));}}catch(error){$('form-message').hidden=false;$('form-message').textContent=error.message;}});
load();
