(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const view = $('#view'), fileInput = $('#fileInput'), modal = $('#modal'), modalForm = $('#modalForm'), toast = $('#toast');

const state = {
  route:'library', bookId:null, chapterIndex:0, selectedParagraph:0, selectedCharOffset:0, selectedWordEnd:0, speakingParagraph:null,
  voices:[], voicesReady:false, isSpeaking:false, isPaused:false, deferredPrompt:null, activeUtterance:null, localSpeakingId:null, localTTSReady:false,
  playbackToken:0, speakingPIndex:null, speakingSIndex:null, speakingSegments:null, replayCurrent:null,
  sleepTimerId:null, sleepIntervalId:null, sleepDeadline:null, sleepMinutes:0, wakeLock:null, chapterTransitionNotice:'',
  cloudReady:false, cloudUser:null, cloudBusy:false, cloudConflict:null, cloudContainer:null, cloudDB:null,
  cloudProgressTimer:null, cloudLibraryTimer:null, cloudApplyingRemote:false
};

const PREF='storyline.prefs.v1';
const SYNC_META='storyline.sync.v1';
const CLOUD_LIBRARY_RECORD='storyline-library-v1';
const CLOUD_PROGRESS_RECORD='storyline-progress-v1';
const dbName='storyline-studio';
let db;
let storylineCloud=null;
function syncMeta(){try{return JSON.parse(localStorage.getItem(SYNC_META)||'{}')}catch{return{}}}
function saveSyncMeta(patch){localStorage.setItem(SYNC_META,JSON.stringify({...syncMeta(),...patch}))}
function syncDeviceId(){let m=syncMeta();if(!m.deviceId){m.deviceId=uid();saveSyncMeta({deviceId:m.deviceId})}return m.deviceId}
function cloudConfig(){return window.STORYLINE_CLOUDKIT_CONFIG||{}}
function cloudConfigured(){const cfg=cloudConfig();return !!(cfg.enabled&&cfg.containerIdentifier&&cfg.apiToken&&window.CloudKit)}
const savedAudioObjectUrls=new Set();
function revokeSavedAudioObjectUrls(){
  for(const url of savedAudioObjectUrls){try{URL.revokeObjectURL(url)}catch{}}
  savedAudioObjectUrls.clear();
}

function showToast(msg){ toast.textContent=msg; toast.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>toast.classList.remove('show'),2200); }
function uid(){ return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2); }
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function prefs(){ try{return JSON.parse(localStorage.getItem(PREF)||'{}')}catch{return{}} }
function savePrefs(patch){ localStorage.setItem(PREF,JSON.stringify({...prefs(),...patch})); }
function isIOS(){ return /iPhone|iPad|iPod/i.test(navigator.userAgent||''); }
function currentEngine(){ return 'device'; }
function localVoiceVariant(){ const v=prefs().localVariant||'f2'; return ['f2','f3','m3'].includes(v)?v:'f2'; }
function voiceKey(v){ return v?.voiceURI || `${v?.name||''}|${v?.lang||''}`; }
function voiceDisplayName(v){ return `${v?.name||'Device voice'}${v?.lang?' · '+v.lang:''}${v?.localService?' · on device':''}`; }
function excerpt(s,n=180){ const x=(s||'').trim(); return x.length>n?x.slice(0,n-1)+'…':x; }
function formatItemTime(iso){
  if(!iso)return '';
  const d=new Date(iso); if(Number.isNaN(d.getTime()))return '';
  try{return new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}).format(d)}catch{return d.toLocaleString()}
}
function formatDuration(sec){
  const n=Math.max(0,Math.round(Number(sec)||0)); const m=Math.floor(n/60),s=n%60; return `${m}:${String(s).padStart(2,'0')}`;
}
function splitSentences(text){
  const t=(text||'').trim(); if(!t) return [];
  try{
    if(typeof Intl!=='undefined' && Intl.Segmenter){
      const seg=new Intl.Segmenter('en',{granularity:'sentence'});
      return [...seg.segment(t)].map(x=>x.segment.trim()).filter(Boolean);
    }
  }catch{}
  return t.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)/g)?.map(x=>x.trim()).filter(Boolean) || [t];
}
function sentenceSegments(text,startOffset=0){
  const source=String(text||''); const base=Math.max(0,Math.min(startOffset,source.length)); const tail=source.slice(base);
  const out=[];
  try{
    if(typeof Intl!=='undefined' && Intl.Segmenter){
      const seg=new Intl.Segmenter('en',{granularity:'sentence'});
      for(const part of seg.segment(tail)){
        const raw=part.segment||''; const lead=(raw.match(/^\s*/)||[''])[0].length; const trimmed=raw.trim();
        if(!trimmed) continue;
        const start=base+part.index+lead;
        out.push({text:trimmed,start,end:start+trimmed.length});
      }
      if(out.length) return out;
    }
  }catch{}
  for(const m of tail.matchAll(/[^.!?]+(?:[.!?]+["'”’)]*|$)/g)){
    const raw=m[0]||''; const lead=(raw.match(/^\s*/)||[''])[0].length; const trimmed=raw.trim();
    if(!trimmed) continue;
    const start=base+(m.index||0)+lead;
    out.push({text:trimmed,start,end:start+trimmed.length});
  }
  return out.length?out:[{text:tail.trim(),start:base,end:source.length}];
}
function caretOffsetInParagraph(p,e){
  let node=null,offset=0;
  try{
    if(document.caretRangeFromPoint){
      const r=document.caretRangeFromPoint(e.clientX,e.clientY); if(r){node=r.startContainer;offset=r.startOffset;}
    }else if(document.caretPositionFromPoint){
      const pos=document.caretPositionFromPoint(e.clientX,e.clientY); if(pos){node=pos.offsetNode;offset=pos.offset;}
    }
    if(!node||!p.contains(node)) return 0;
    const pre=document.createRange(); pre.selectNodeContents(p); pre.setEnd(node,offset); return pre.toString().length;
  }catch{return 0}
}
function wordRangeAt(text,offset){
  const words=[...String(text||'').matchAll(/\S+/g)]; if(!words.length)return {start:0,end:0,word:''};
  const w=words.find(m=>offset>=m.index&&offset<=m.index+m[0].length) || words.find(m=>m.index>=offset) || words[words.length-1];
  return {start:w.index,end:w.index+w[0].length,word:w[0]};
}
function markStartWord(paragraphIndex,start,end){
  const p=$(`#readingPage p[data-p="${paragraphIndex}"]`); if(!p)return;
  const text=p.textContent||''; const a=Math.max(0,Math.min(start,text.length)); const b=Math.max(a,Math.min(end,text.length));
  p.innerHTML=escapeHtml(text.slice(0,a))+`<span class="word-start">${escapeHtml(text.slice(a,b))}</span>`+escapeHtml(text.slice(b));
}
function highlightRange(paragraphIndex,start,end){
  const p=$(`#readingPage p[data-p="${paragraphIndex}"]`); if(!p)return;
  const text=p.textContent||''; const a=Math.max(0,Math.min(start,text.length)); const b=Math.max(a,Math.min(end,text.length));
  p.innerHTML=escapeHtml(text.slice(0,a))+`<span class="sentence-speaking">${escapeHtml(text.slice(a,b))}</span>`+escapeHtml(text.slice(b));
}


async function openDB(){
  return new Promise((res,rej)=>{ const r=indexedDB.open(dbName,1); r.onupgradeneeded=()=>{
    const d=r.result; if(!d.objectStoreNames.contains('books')) d.createObjectStore('books',{keyPath:'id'});
    if(!d.objectStoreNames.contains('items')){ const s=d.createObjectStore('items',{keyPath:'id'}); s.createIndex('bookId','bookId'); s.createIndex('type','type'); }
  }; r.onsuccess=()=>{db=r.result;res(db)}; r.onerror=()=>rej(r.error); });
}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function idbGetAll(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function idbGet(name,id){return new Promise((res,rej)=>{const r=store(name).get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function idbPut(name,obj){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(obj);r.onsuccess=()=>{if(name==='items'&&!state.cloudApplyingRemote)storylineCloud?.markLibraryDirty();res(obj)};r.onerror=()=>rej(r.error)})}
function idbDelete(name,id){return new Promise((res,rej)=>{const r=store(name,'readwrite').delete(id);r.onsuccess=()=>{if((name==='items'||name==='books')&&!state.cloudApplyingRemote)storylineCloud?.markLibraryDirty();res()};r.onerror=()=>rej(r.error)})}
function idbClear(name){return new Promise((res,rej)=>{const r=store(name,'readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function replaceLibraryAtomically(books,items){
  return new Promise((res,rej)=>{
    let tx;
    try{
      tx=db.transaction(['books','items'],'readwrite');
      const booksStore=tx.objectStore('books'),itemsStore=tx.objectStore('items');
      let settled=false;
      tx.oncomplete=()=>{if(!settled){settled=true;res()}};
      tx.onabort=()=>{if(!settled){settled=true;rej(tx.error||new Error('Restore transaction was rolled back.'))}};
      tx.onerror=()=>{};
      try{
        booksStore.clear();itemsStore.clear();
        for(const book of books)booksStore.put(book);
        for(const item of items)itemsStore.put(item);
      }catch(e){
        try{tx.abort()}catch{}
        if(!settled){settled=true;rej(e)}
      }
    }catch(e){
      try{tx?.abort()}catch{}
      rej(e);
    }
  });
}

function splitChapters(paragraphs){
  const chapters=[]; let current={title:'Front matter', paragraphs:[],synthetic:true};
  const heading=/^(chapter\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[a-z-]+)|prologue|epilogue)\b/i;
  for(const raw of paragraphs){ const p=raw.trim(); if(!p) continue;
    if(heading.test(p) && current.paragraphs.length){ chapters.push(current); current={title:p,paragraphs:[],synthetic:false}; }
    else if(heading.test(p) && !current.paragraphs.length){ current.title=p; current.synthetic=false; }
    else current.paragraphs.push(p);
  }
  if(current.paragraphs.length) chapters.push(current);
  if(!chapters.length) chapters.push({title:'Manuscript',paragraphs:paragraphs.filter(Boolean)});
  return chapters;
}

async function parseDocx(file){
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const doc=zip.file('word/document.xml');if(!doc)throw new Error('This DOCX does not contain a readable document body.');
  const xml=await doc.async('string');
  const dom=new DOMParser().parseFromString(xml,'application/xml');
  return [...dom.getElementsByTagNameNS('*','p')].map(p=>[...p.getElementsByTagNameNS('*','t')].map(t=>t.textContent).join('')).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
}
function htmlParagraphs(html){
  const dom=new DOMParser().parseFromString(html,'text/html');
  dom.querySelectorAll('script,style,noscript,svg,nav').forEach(n=>n.remove());
  const selector='h1,h2,h3,h4,h5,h6,p,blockquote,li';
  const nodes=[...dom.body.querySelectorAll(selector)];
  const paras=nodes.map(n=>{
    // Keep this block's own text, but remove nested blocks that will be emitted separately.
    // This avoids EPUB/HTML structures such as <blockquote><p>…</p></blockquote>
    // or <li><p>…</p></li> being read twice.
    const clone=n.cloneNode(true);
    clone.querySelectorAll(selector).forEach(child=>child.remove());
    return (clone.textContent||'').replace(/\s+/g,' ').trim();
  }).filter(Boolean);
  if(paras.length)return paras;
  const text=(dom.body.textContent||'').replace(/\r/g,'');
  return text.split(/\n\s*\n|\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
}
async function parseHtml(file){return htmlParagraphs(await file.text())}
async function parseMarkdown(file){
  const text=(await file.text()).replace(/\r/g,'');
  return text.split(/\n\s*\n|\n/).map(line=>line.trim())
    .map(line=>line.replace(/^#{1,6}\s+/,'').replace(/^>\s?/,'').replace(/^[-*+]\s+/,'').trim())
    .filter(Boolean);
}
async function parseOdt(file){
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const doc=zip.file('content.xml');if(!doc)throw new Error('This ODT does not contain readable document text.');
  const xml=await doc.async('string'),dom=new DOMParser().parseFromString(xml,'application/xml');
  return [...dom.getElementsByTagNameNS('*','body')[0]?.getElementsByTagNameNS('*','p')||[]]
    .map(p=>(p.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
}
function zipResolve(base,relative){
  const stack=(base?base.split('/'):[]);for(const part of String(relative||'').split('/')){
    if(!part||part==='.')continue;if(part==='..')stack.pop();else stack.push(part);
  }return stack.join('/');
}
async function parseEpub(file){
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const container=zip.file('META-INF/container.xml');if(!container)throw new Error('This EPUB does not contain a readable package.');
  const cdom=new DOMParser().parseFromString(await container.async('string'),'application/xml');
  const rootfile=[...cdom.getElementsByTagNameNS('*','rootfile')][0];
  const opfPath=rootfile?.getAttribute('full-path');if(!opfPath)throw new Error('The EPUB package file could not be found.');
  const opf=zip.file(opfPath);if(!opf)throw new Error('The EPUB package file is missing.');
  const odom=new DOMParser().parseFromString(await opf.async('string'),'application/xml');
  const base=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')):'';
  const manifest=new Map([...odom.getElementsByTagNameNS('*','item')].map(n=>[n.getAttribute('id'),n.getAttribute('href')]));
  const spine=[...odom.getElementsByTagNameNS('*','itemref')].map(n=>n.getAttribute('idref')).filter(Boolean);
  const chapters=[];const all=[];
  for(const id of spine){
    const href=manifest.get(id);if(!href)continue;
    const entry=zip.file(zipResolve(base,href.split('#')[0]));if(!entry)continue;
    const paras=htmlParagraphs(await entry.async('string'));if(!paras.length)continue;
    all.push(...paras);
    const heading=paras.find(x=>/^(chapter\b|prologue\b|epilogue\b|part\b)/i.test(x))||paras[0];
    const body=paras[0]===heading?paras.slice(1):paras;
    if(body.length)chapters.push({title:heading||`Section ${chapters.length+1}`,paragraphs:body,synthetic:false});
  }
  if(!all.length)throw new Error('No readable text was found in this EPUB.');
  return {paragraphs:all,chapters:chapters.length?chapters:null};
}
async function parsePdf(file){
  if(!window.pdfjsLib)throw new Error('PDF support has not finished loading. Check your connection and try again.');
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const paras=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
    const page=await pdf.getPage(pageNo),content=await page.getTextContent();
    let line='';
    for(const item of content.items){
      const t=(item.str||'').trim();if(t)line+=(line?' ':'')+t;
      if(item.hasEOL&&line.trim()){paras.push(line.replace(/\s+/g,' ').trim());line=''}
    }
    if(line.trim())paras.push(line.replace(/\s+/g,' ').trim());
  }
  return paras.filter(Boolean);
}
async function importFile(file){
  if(!file)return;
  let paragraphs,parsedChapters=null;
  try{
    const name=file.name.toLowerCase();
    if(name.endsWith('.docx'))paragraphs=await parseDocx(file);
    else if(name.endsWith('.epub')){const parsed=await parseEpub(file);paragraphs=parsed.paragraphs;parsedChapters=parsed.chapters}
    else if(name.endsWith('.pdf'))paragraphs=await parsePdf(file);
    else if(name.endsWith('.odt'))paragraphs=await parseOdt(file);
    else if(name.endsWith('.html')||name.endsWith('.htm'))paragraphs=await parseHtml(file);
    else if(name.endsWith('.md')||name.endsWith('.markdown'))paragraphs=await parseMarkdown(file);
    else if(name.endsWith('.txt'))paragraphs=(await file.text()).replace(/\r/g,'').split(/\n\s*\n|\n/).map(x=>x.trim()).filter(Boolean);
    else throw new Error('That file type is not supported yet.');
    if(!paragraphs?.length)throw new Error('No manuscript text was found.');
    let title=file.name.replace(/\.(docx|epub|pdf|odt|html?|md|markdown|txt)$/i,'').replace(/[_-]+/g,' ').trim();
    const firstUseful=paragraphs.find(p=>p.length>3&&!/^chapter\b/i.test(p));
    if(/the plus[ -]one problem/i.test(title)||/^the plus[ -]one problem/i.test(firstUseful||''))title='The Plus-One Problem';
    const chapters=parsedChapters||splitChapters(paragraphs);
    const book={id:uid(),title,fileName:file.name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),chapters,progress:{chapterIndex:0,paragraphIndex:0,charOffset:0,wordEnd:0,completed:false},version:'Imported manuscript'};
    await idbPut('books',book);storylineCloud?.markLibraryDirty();state.bookId=book.id;state.chapterIndex=0;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;
    savePrefs({lastBookId:book.id});showToast(`Imported ${book.chapters.length} chapter${book.chapters.length===1?'':'s'}`);navigate('reader');
  }catch(e){showToast(e.message||'Could not import manuscript')}
}

async function updateQueueBadge(){ const items=await idbGetAll('items'); const open=items.filter(i=>['question','continuity','note','bookmark','voice'].includes(i.type)&&i.status!=='done').length; const b=$('#queueBadge'); b.textContent=open; b.classList.toggle('hidden',!open); }
function setNav(route){
  $$('.nav-item[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===route));
  document.body.classList.toggle('reader-route',route==='reader');
  document.body.classList.remove('mobile-tools-open');
  const tools=$('#readerNavTools'); if(tools)tools.classList.toggle('hidden',route!=='reader');
}
async function navigate(route){
  if(route==='reader'&&!state.bookId){ const books=await idbGetAll('books'); if(books[0]) state.bookId=books[0].id; else route='library'; }
  revokeSavedAudioObjectUrls();
  state.route=route; setNav(route); stopAllSpeech();
  if(route==='library') await renderLibrary(); if(route==='reader') await renderReader(); if(route==='notes') await renderNotes(); if(route==='queue') await renderQueue(); if(route==='actioned') await renderActioned(); updateQueueBadge();
}

function arrayBufferToBase64(buffer){
  const bytes=new Uint8Array(buffer);let binary='';const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToArrayBuffer(base64){
  const binary=atob(base64);const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes.buffer;
}
async function backupItem(item){
  const copy={...item};
  if(copy.audioData instanceof ArrayBuffer){
    copy.audioBackup={encoding:'base64',type:copy.audioType||'audio/mp4',data:arrayBufferToBase64(copy.audioData)};
    delete copy.audioData;
  }else if(copy.audioBlob instanceof Blob){
    copy.audioBackup={encoding:'base64',type:copy.audioBlob.type||copy.audioType||'audio/mp4',data:arrayBufferToBase64(await copy.audioBlob.arrayBuffer())};
    delete copy.audioBlob;
  }
  return copy;
}
async function cloudLibrarySnapshot(){
  const books=await idbGetAll('books'),rawItems=await idbGetAll('items'),items=[];
  for(const item of rawItems)items.push(await backupItem(item));
  return {app:'Storyline Studio',schemaVersion:1,syncedAt:new Date().toISOString(),books,items};
}
function restoreCloudItem(item){
  const copy={...item};
  if(copy.audioBackup?.encoding==='base64'&&copy.audioBackup.data){
    copy.audioData=base64ToArrayBuffer(copy.audioBackup.data);
    copy.audioType=copy.audioBackup.type||copy.audioType||'audio/mp4';
  }
  delete copy.audioBackup;
  return copy;
}
async function applyCloudLibraryPayload(data){
  if(data?.app!=='Storyline Studio'||!Array.isArray(data.books)||!Array.isArray(data.items))throw new Error('The iCloud Storyline library is invalid.');
  const items=data.items.map(restoreCloudItem);
  state.cloudApplyingRemote=true;
  try{await replaceLibraryAtomically(data.books,items)}finally{state.cloudApplyingRemote=false}
  const last=prefs().lastBookId;
  state.bookId=(last&&data.books.some(b=>b.id===last))?last:(data.books[0]?.id||null);
  if(state.bookId){
    const b=await idbGet('books',state.bookId);
    state.chapterIndex=b?.progress?.chapterIndex||0;
    state.selectedParagraph=b?.progress?.paragraphIndex||0;
    state.selectedCharOffset=b?.progress?.charOffset||0;
    state.selectedWordEnd=b?.progress?.wordEnd||0;
    savePrefs({lastBookId:state.bookId});
  }
}
async function cloudProgressSnapshot(){
  const books=await idbGetAll('books');
  return {schemaVersion:1,syncedAt:new Date().toISOString(),lastBookId:prefs().lastBookId||null,books:Object.fromEntries(books.map(b=>[b.id,b.progress||{}]))};
}
async function applyCloudProgressPayload(data){
  const remote=data?.books||{};
  state.cloudApplyingRemote=true;
  try{
    for(const [id,p] of Object.entries(remote)){
      const book=await idbGet('books',id);if(!book)continue;
      const remoteAt=Date.parse(p?.updatedAt||0)||0;
      const localAt=Date.parse(book.progress?.updatedAt||0)||0;
      if(remoteAt>localAt){book.progress={...book.progress,...p};book.updatedAt=new Date(Math.max(Date.parse(book.updatedAt||0)||0,remoteAt)).toISOString();await idbPut('books',book)}
    }
  }finally{state.cloudApplyingRemote=false}
  if(data?.lastBookId&&await idbGet('books',data.lastBookId))savePrefs({lastBookId:data.lastBookId});
}
function updateCloudStatus(message,kind=''){
  const el=$('#cloudSyncStatus');if(el){el.textContent=message;el.dataset.state=kind}
}
function showCloudConflict(show){
  const el=$('#cloudConflictActions');if(el)el.classList.toggle('hidden',!show);
}
function ensureStorylineCloud(){
  if(storylineCloud)return storylineCloud;
  if(!window.StorylineCloudSync)return null;
  storylineCloud=window.StorylineCloudSync.create({
    config:cloudConfig,
    deviceId:syncDeviceId,
    localBookCount:async()=>(await idbGetAll('books')).length,
    getLibrary:cloudLibrarySnapshot,
    applyLibrary:applyCloudLibraryPayload,
    getProgress:cloudProgressSnapshot,
    applyProgress:applyCloudProgressPayload,
    onStatus:updateCloudStatus,
    onConflict:showCloudConflict
  });
  return storylineCloud;
}
async function exportBackup(){
  try{
    const books=await idbGetAll('books'),rawItems=await idbGetAll('items');
    const items=[];for(const item of rawItems)items.push(await backupItem(item));
    const payload={app:'Storyline Studio',schemaVersion:1,exportedAt:new Date().toISOString(),books,items,preferences:prefs()};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    const date=new Date().toISOString().slice(0,10);
    a.href=url;a.download=`storyline-backup-${date}.json`;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    showToast('Storyline backup exported');
  }catch(e){showToast(e.message||'Backup could not be exported')}
}
async function restoreBackup(file){
  if(!file)return;
  try{
    const data=JSON.parse(await file.text());
    if(data?.app!=='Storyline Studio'||!Array.isArray(data.books)||!Array.isArray(data.items))throw new Error('This is not a valid Storyline backup.');
    if(Number(data.schemaVersion||0)>1)throw new Error('This backup was created by a newer Storyline version.');
    if(data.books.some(book=>!book||!book.id)||data.items.some(item=>!item||!item.id))throw new Error('This backup contains records without valid IDs.');
    const bookIds=new Set(data.books.map(book=>book.id)),itemIds=new Set(data.items.map(item=>item.id));
    if(bookIds.size!==data.books.length||itemIds.size!==data.items.length)throw new Error('This backup contains duplicate record IDs.');
    const items=data.items.map(item=>{
      const copy={...item};
      if(copy.audioBackup?.encoding==='base64'&&copy.audioBackup.data){
        copy.audioData=base64ToArrayBuffer(copy.audioBackup.data);
        copy.audioType=copy.audioBackup.type||copy.audioType||'audio/mp4';
      }
      delete copy.audioBackup;
      return copy;
    });
    if(!confirm(`Restore this backup? It will replace the ${(await idbGetAll('books')).length} manuscript(s) and all notes currently stored in this browser.`))return;

    // Replace both stores in one IndexedDB transaction. If any clear/put fails,
    // IndexedDB rolls the entire restore back instead of leaving a half-restored library.
    await replaceLibraryAtomically(data.books,items);
    storylineCloud?.markLibraryDirty();

    if(data.preferences&&typeof data.preferences==='object')localStorage.setItem(PREF,JSON.stringify(data.preferences));
    const p=prefs();
    state.bookId=(p.lastBookId&&bookIds.has(p.lastBookId))?p.lastBookId:(data.books[0]?.id||null);
    if(state.bookId){const book=await idbGet('books',state.bookId);state.chapterIndex=book?.progress?.chapterIndex||0;state.selectedParagraph=book?.progress?.paragraphIndex||0;state.selectedCharOffset=book?.progress?.charOffset||0;state.selectedWordEnd=book?.progress?.wordEnd||0}
    showToast('Storyline backup restored');
    await navigate('library');
  }catch(e){showToast(e.message||'Backup could not be restored')}
}
async function renderLibrary(){
  const books=(await idbGetAll('books')).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  const items=await idbGetAll('items');
  view.innerHTML=`
    <section class="hero"><div class="eyebrow">Your private listening desk</div><h1>Read with your ears.<br>Revise with receipts.</h1><p class="sub">Your manuscript stays in this browser. Storyline remembers where you stopped and keeps every note tied to its exact passage.</p></section>
    <section class="import-zone"><strong>${books.length?'Add another manuscript':'Bring in a manuscript'}</strong><p class="sub">DOCX, EPUB, PDF, ODT, Markdown, HTML, or TXT. Chapter headings are detected automatically.</p><button id="importBtn" class="button">Choose manuscript</button><div class="privacy">Local-first: importing a file does not upload it to a server.</div></section>
    <section class="backup-card card"><div><div class="eyebrow">Data safety</div><h2>Backup & restore</h2><p class="sub">Export manuscripts, reading positions, Queue and Actioned items, preferences, and saved voice-note audio.</p></div><div class="row backup-actions"><button id="exportBackupBtn" class="ghost">Export backup</button><button id="restoreBackupBtn" class="ghost">Restore backup</button><input id="restoreBackupInput" type="file" accept="application/json,.json" hidden /></div></section>
    ${books.length?`<h2 class="section-title">My manuscripts</h2><div class="grid books">${books.map(b=>bookCard(b,items)).join('')}</div>`:`<div class="empty">Your library is waiting for its first book.</div>`}
  `;
  $('#importBtn').onclick=()=>fileInput.click();
  $('#exportBackupBtn').onclick=exportBackup;
  $('#restoreBackupBtn').onclick=()=>$('#restoreBackupInput').click();
  $('#restoreBackupInput').onchange=e=>{const file=e.target.files?.[0];e.target.value='';restoreBackup(file)};
  $$('.book-card').forEach(c=>c.onclick=async e=>{ if(e.target.closest('[data-delete]')) return; state.bookId=c.dataset.id; savePrefs({lastBookId:state.bookId}); const b=await idbGet('books',state.bookId); state.chapterIndex=b.progress?.chapterIndex||0; state.selectedParagraph=b.progress?.paragraphIndex||0; state.selectedCharOffset=b.progress?.charOffset||0; state.selectedWordEnd=b.progress?.wordEnd||0; navigate('reader'); });
  $$('[data-delete]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=btn.dataset.delete; if(confirm('Remove this manuscript and its saved notes from this device?')){await idbDelete('books',id); const all=await idbGetAll('items'); for(const i of all.filter(x=>x.bookId===id)) await idbDelete('items',i.id); if(state.bookId===id) state.bookId=null; renderLibrary(); updateQueueBadge();}});
}
function chapterLabel(ch,book){ return (ch?.synthetic||ch?.title==='Beginning'||ch?.title==='Front matter')?(book?.title||'Manuscript'):(ch?.title||'Manuscript'); }
function readerChapterTitle(ch){ return (ch?.synthetic||ch?.title==='Beginning'||ch?.title==='Front matter')?'':(ch?.title||''); }
function bookCard(b,items){ const total=b.chapters.reduce((n,c)=>n+c.paragraphs.length,0); let before=0; for(let i=0;i<(b.progress?.chapterIndex||0);i++) before+=b.chapters[i]?.paragraphs.length||0; before+=b.progress?.paragraphIndex||0; const pct=b.progress?.completed===true?100:Math.max(0,Math.min(100,Math.round((before/Math.max(total,1))*100))); const count=items.filter(i=>i.bookId===b.id&&['note','question','continuity'].includes(i.type)).length;
  return `<article class="card book-card" data-id="${b.id}"><div><div class="eyebrow">${escapeHtml(b.version||'Manuscript')}</div><div class="book-title">${escapeHtml(b.title)}</div><p class="meta">${b.chapters.length} chapter${b.chapters.length===1?'':'s'} · ${count} note${count===1?'':'s'}</p></div><div class="stack"><div class="row between"><span class="meta">${pct}% listened</span><button data-delete="${b.id}" class="ghost tiny">Remove</button></div><div class="progress"><i style="width:${pct}%"></i></div><button class="button">Continue reading</button></div></article>`;
}

async function renderReader(){
  const book=await idbGet('books',state.bookId); if(!book){navigate('library');return}
  state.chapterIndex=Math.max(0,Math.min(state.chapterIndex,book.chapters.length-1)); const ch=book.chapters[state.chapterIndex]; state.selectedParagraph=Math.max(0,Math.min(state.selectedParagraph,ch.paragraphs.length-1));
  const p=prefs();
  view.innerHTML=`
    <section class="reader-header"><div class="row between"><div><div class="eyebrow">${escapeHtml(book.title)}</div>${readerChapterTitle(ch)?`<h2 class="reader-title">${escapeHtml(readerChapterTitle(ch))}</h2>`:''}</div><button id="backLibrary" class="ghost tiny">Library</button></div>
    <select id="chapterSelect" class="chapter-select">${book.chapters.map((c,i)=>`<option value="${i}" ${i===state.chapterIndex?'selected':''}>${escapeHtml(chapterLabel(c,book))}</option>`).join('')}</select></section>
    <article id="readingPage" class="reading-page" aria-label="Manuscript text">${ch.paragraphs.map((t,i)=>`<p data-p="${i}" class="${i===state.selectedParagraph?'selected':''}">${escapeHtml(t)}</p>`).join('')}</article>
    <section class="player compact-player">
      <div class="player-main compact-player-main">
        <div class="transport-buttons">
          <button id="prevBtn" class="ghost transport-skip" aria-label="Previous paragraph">‹</button>
          <button id="playBtn" class="button play" aria-label="Play">▶</button>
          <button id="nextBtn" class="ghost transport-skip" aria-label="Next paragraph">›</button>
          <button id="replayBtn" class="ghost transport-replay" aria-label="Replay current sentence" disabled>↺</button>
        </div>
        <div class="transport-progress"><div class="row between"><span id="positionLabel" class="meta">Paragraph ${state.selectedParagraph+1} of ${ch.paragraphs.length}</span><span id="speedLabel" class="meta">${p.rate||1.05}×</span></div><input id="positionRange" class="range" type="range" min="0" max="${Math.max(ch.paragraphs.length-1,0)}" value="${state.selectedParagraph}" /></div>
      </div>
      <div class="compact-status"><span id="voiceStatus" class="reading-status">Loading device voices…</span></div>
      <details id="voiceOptions" class="voice-options">
        <summary><span>Voice & speed</span><span id="voiceSummary" class="meta">Samantha · ${p.rate||1.05}×</span></summary>
        <div class="voice-options-panel">
          <select id="voiceSelect" class="select"><option>Loading voices…</option></select>
          <div class="row voice-manage-actions"><button id="hideVoiceBtn" class="ghost tiny">Hide selected voice</button><button id="restoreVoicesBtn" class="ghost tiny hidden">Restore hidden voices</button></div>
          <div class="speed-box"><span class="meta">Speed</span><input id="rateRange" class="range" type="range" min="0.75" max="1.75" step="0.05" value="${p.rate||1.05}" title="Reading speed" /></div>
          <button id="testVoiceBtn" class="ghost tiny">Test selected voice</button>
          <div class="sleep-box"><span class="meta">Sleep timer</span><select id="sleepTimerSelect" class="select"><option value="0">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select><span id="sleepTimerStatus" class="meta">Sleep timer off</span></div>
          <label class="chapter-advance-toggle"><input id="autoAdvanceToggle" type="checkbox" ${p.autoAdvance!==false?'checked':''} /><span><strong>Continue to next chapter</strong><small>Keep reading automatically when a chapter ends.</small></span></label>
          <div class="wake-note meta">Screen stays awake while Storyline reads, when supported. Manually locking the device can still pause playback.</div>
        </div>
      </details>
    </section>`;
  wireReader(book,ch); loadVoices(); requestAnimationFrame(()=>{ if(state.sleepDeadline){const sleep=$('#sleepTimerSelect');if(sleep)sleep.value=String(state.sleepMinutes||0);updateSleepTimerStatus()} if(state.selectedCharOffset>0) markStartWord(state.selectedParagraph,state.selectedCharOffset,state.selectedWordEnd||state.selectedCharOffset); scrollSelected(false); });
}

function wireReader(book,ch){
  $('#backLibrary').onclick=()=>navigate('library');
  $('#chapterSelect').onchange=async e=>{ stopAllSpeech(); state.chapterIndex=+e.target.value; state.selectedParagraph=0; state.selectedCharOffset=0; state.selectedWordEnd=0; await saveProgress(book); renderReader(); };
  $$('#readingPage p').forEach(p=>p.onclick=async e=>{
    stopAllSpeech();
    const text=p.textContent||''; const wr=wordRangeAt(text,caretOffsetInParagraph(p,e));
    state.selectedCharOffset=wr.start; state.selectedWordEnd=wr.end;
    await selectParagraph(+p.dataset.p,false,true);
    markStartWord(+p.dataset.p,wr.start,wr.end);
    const label=$('#positionLabel'); if(label) label.textContent=`Paragraph ${+p.dataset.p+1} · starts “${wr.word}”`;
  });
  $('#positionRange').oninput=e=>{stopAllSpeech();state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(+e.target.value,true);};
  $('#playBtn').onclick=toggleSpeech;
  $('#prevBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.max(0,state.selectedParagraph-1)); };
  $('#nextBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.min(ch.paragraphs.length-1,state.selectedParagraph+1)); };
  $('#testVoiceBtn').onclick=testVoice;
  $('#replayBtn').onclick=replayCurrentSentence;
  $('#sleepTimerSelect').onchange=e=>setSleepTimer(+e.target.value);
  $('#autoAdvanceToggle').onchange=e=>savePrefs({autoAdvance:e.target.checked});
  $('#rateRange').oninput=e=>{const r=+e.target.value; savePrefs({rate:r}); $('#speedLabel').textContent=r+'×'; updateVoiceSummary();};
  const voiceSelect=$('#voiceSelect'); if(voiceSelect) voiceSelect.onchange=e=>{
    const chosen=state.voices.find(v=>voiceKey(v)===e.target.value);
    if(chosen)savePrefs({voiceKey:voiceKey(chosen),voiceName:chosen.name});
    updateVoiceSummary();
  };
  const hideVoice=$('#hideVoiceBtn');if(hideVoice)hideVoice.onclick=()=>{
    const chosen=state.voices.find(v=>voiceKey(v)===voiceSelect?.value);if(!chosen)return;
    const p=prefs(),hidden=new Set(p.hiddenVoiceKeys||[]);
    hidden.add(voiceKey(chosen));savePrefs({hiddenVoiceKeys:[...hidden]});loadVoices();showToast(`${chosen.name} hidden from Storyline`);
  };
  const restoreVoices=$('#restoreVoicesBtn');if(restoreVoices)restoreVoices.onclick=()=>{
    savePrefs({hiddenVoiceKeys:[],hiddenVoices:[]});loadVoices();showToast('Hidden voices restored');
  };
}
async function selectParagraph(i,noScroll=false,preserveWord=false){ state.selectedParagraph=i; if(!preserveWord){state.selectedCharOffset=0;state.selectedWordEnd=0;} $$('#readingPage p').forEach(p=>p.classList.toggle('selected',+p.dataset.p===i)); $('#positionRange').value=i; $('#positionLabel').textContent=`Paragraph ${i+1} of ${$('#readingPage').children.length}`; const book=await idbGet('books',state.bookId); await saveProgress(book); if(!noScroll) scrollSelected(); }
function scrollSelected(smooth=true){ const el=$(`#readingPage p[data-p="${state.selectedParagraph}"]`); if(el) el.scrollIntoView({block:'center',behavior:smooth?'smooth':'auto'}); }
function progressSnapshot(){return {chapterIndex:state.chapterIndex,paragraphIndex:state.selectedParagraph,charOffset:state.selectedCharOffset||0,wordEnd:state.selectedWordEnd||0}}
async function saveProgress(book,{snapshot=null,completed=null,updatePrefs=true}={}){
  if(!book)return;
  const pos=snapshot||progressSnapshot();
  const wasCompleted=book.progress?.completed===true;
  const progressUpdatedAt=new Date().toISOString();
  book.progress={chapterIndex:pos.chapterIndex,paragraphIndex:pos.paragraphIndex,charOffset:pos.charOffset||0,wordEnd:pos.wordEnd||0,completed:completed===null?wasCompleted:!!completed,updatedAt:progressUpdatedAt};
  book.updatedAt=progressUpdatedAt;
  await idbPut('books',book);
  if(!state.cloudApplyingRemote)storylineCloud?.markProgressDirty();
  if(updatePrefs)savePrefs({lastBookId:book.id,lastChapterIndex:pos.chapterIndex,lastParagraphIndex:pos.paragraphIndex,lastCharOffset:pos.charOffset||0,lastWordEnd:pos.wordEnd||0});
}
function persistReadingProgress(){
  const bookId=state.bookId,snapshot=progressSnapshot();
  if(!bookId)return;
  idbGet('books',bookId).then(book=>book&&saveProgress(book,{snapshot,updatePrefs:false})).catch(()=>{});
}
function updateVoiceSummary(){
  const sel=$('#voiceSelect'); const summary=$('#voiceSummary'); const st=$('#voiceStatus');
  const name=sel?.selectedOptions?.[0]?.dataset?.name || prefs().voiceName || 'Device voice';
  const rate=prefs().rate||1.05;
  if(summary)summary.textContent=`${name} · ${rate}×`;
  if(st&&!state.isSpeaking)st.textContent=`${name} ready`;
}
function setSpeechControlsReady(ready){
  state.voicesReady=!!ready;
  const play=$('#playBtn'); if(play){play.disabled=!ready;play.setAttribute('aria-disabled',String(!ready));}
  $$('[data-reader-act="start"]').forEach(b=>{b.disabled=!ready;b.setAttribute('aria-disabled',String(!ready))});
  const st=$('#voiceStatus');
  if(st&&!state.isSpeaking)st.textContent=ready?`${$('#voiceSelect')?.value||prefs().voiceName||'Device voice'} ready`:'Loading device voices…';
}
function loadVoices(){
  const optionHtml=v=>`<option value="${escapeHtml(voiceKey(v))}" data-name="${escapeHtml(v.name)}">${escapeHtml(voiceDisplayName(v))}</option>`;
  const groupHtml=(label,voices)=>voices.length?`<optgroup label="${escapeHtml(label)}">${voices.map(optionHtml).join('')}</optgroup>`:'';
  const fill=()=>{
    const allVoices=speechSynthesis.getVoices();
    state.voices=allVoices;
    const sel=$('#voiceSelect');if(!sel)return;
    if(!allVoices.length){
      sel.innerHTML='<option>Loading device voices…</option>';
      setSpeechControlsReady(false);
      return;
    }

    const p=prefs();
    const hiddenKeys=new Set(p.hiddenVoiceKeys||[]);
    const hiddenNames=new Set(p.hiddenVoices||[]);
    const english=allVoices.filter(v=>/^en(?:-|_)/i.test(v.lang||''));
    const visible=english.filter(v=>!hiddenKeys.has(voiceKey(v))&&!hiddenNames.has(v.name));
    const samantha=visible.find(v=>v.name==='Samantha');
    const recommended=samantha?[samantha]:[];
    const used=new Set(recommended.map(voiceKey));
    const installed=visible.filter(v=>v.localService&&!used.has(voiceKey(v))).sort((a,b)=>a.name.localeCompare(b.name));
    installed.forEach(v=>used.add(voiceKey(v)));
    const other=visible.filter(v=>!used.has(voiceKey(v))).sort((a,b)=>a.name.localeCompare(b.name));

    sel.innerHTML=groupHtml('Recommended',recommended)+groupHtml('English · on device',installed)+groupHtml('Other English voices',other);
    const restore=$('#restoreVoicesBtn');if(restore)restore.classList.toggle('hidden',hiddenKeys.size===0&&hiddenNames.size===0);
    const hide=$('#hideVoiceBtn');

    if(!visible.length){
      sel.innerHTML='<option value="">No visible English voices</option>';
      if(hide)hide.disabled=true;
      setSpeechControlsReady(false);
      updateVoiceSummary();
      return;
    }
    if(hide)hide.disabled=false;

    let wanted=p.voiceKey||'';
    if(!wanted&&p.voiceName){
      const old=visible.find(v=>v.name===p.voiceName);if(old)wanted=voiceKey(old);
    }
    if(!visible.some(v=>voiceKey(v)===wanted))wanted=samantha?voiceKey(samantha):voiceKey(visible[0]);
    sel.value=wanted;
    const chosen=visible.find(v=>voiceKey(v)===sel.value)||samantha||visible[0];
    if(chosen){sel.value=voiceKey(chosen);savePrefs({voiceKey:voiceKey(chosen),voiceName:chosen.name})}
    setSpeechControlsReady(true);
    updateVoiceSummary();
  };
  setSpeechControlsReady(false);
  fill();
  speechSynthesis.onvoiceschanged=fill;
}
function clearSleepTimer(){
  if(state.sleepTimerId){clearTimeout(state.sleepTimerId);state.sleepTimerId=null}
  if(state.sleepIntervalId){clearInterval(state.sleepIntervalId);state.sleepIntervalId=null}
  state.sleepDeadline=null;state.sleepMinutes=0;
  const status=$('#sleepTimerStatus'); if(status)status.textContent='Sleep timer off';
  const select=$('#sleepTimerSelect'); if(select)select.value='0';
}
function updateSleepTimerStatus(){
  const status=$('#sleepTimerStatus'); if(!status)return;
  if(!state.sleepDeadline){status.textContent='Sleep timer off';return}
  const left=Math.max(0,state.sleepDeadline-Date.now());
  const total=Math.ceil(left/1000),m=Math.floor(total/60),sec=total%60;
  status.textContent=`Sleep timer · ${m}:${String(sec).padStart(2,'0')}`;
}
function setSleepTimer(minutes){
  if(state.sleepTimerId)clearTimeout(state.sleepTimerId);
  if(state.sleepIntervalId)clearInterval(state.sleepIntervalId);
  state.sleepTimerId=null;state.sleepIntervalId=null;state.sleepDeadline=null;state.sleepMinutes=0;
  const n=Number(minutes)||0;
  if(!n){updateSleepTimerStatus();return}
  state.sleepMinutes=n;state.sleepDeadline=Date.now()+n*60000;
  updateSleepTimerStatus();
  state.sleepIntervalId=setInterval(updateSleepTimerStatus,1000);
  state.sleepTimerId=setTimeout(()=>{
    state.sleepTimerId=null;
    stopAllSpeech();
    showToast('Sleep timer ended');
  },n*60000);
}
async function requestWakeLock(){
  if(!state.isSpeaking||!navigator.wakeLock?.request||document.visibilityState==='hidden')return;
  try{
    if(state.wakeLock)return;
    const lock=await navigator.wakeLock.request('screen');
    if(!state.isSpeaking){try{await lock.release()}catch{};return}
    state.wakeLock=lock;
    lock.addEventListener?.('release',()=>{if(state.wakeLock===lock)state.wakeLock=null});
  }catch{}
}
async function releaseWakeLock(){
  const lock=state.wakeLock;state.wakeLock=null;
  try{await lock?.release?.()}catch{}
}
function toggleSpeech(){
  if(!state.voicesReady){showToast('Device voices are still loading.');return}
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  if(state.isSpeaking&&!state.isPaused){ speechSynthesis.pause(); state.isPaused=true; $('#playBtn').textContent='▶'; return; }
  if(state.isSpeaking&&state.isPaused){ speechSynthesis.resume(); state.isPaused=false; $('#playBtn').textContent='Ⅱ'; return; }
  startSpeech(true);
}
function startSpeech(fromSelected=true){
  if(!state.voicesReady){showToast('Device voices are still loading.');return}
  if(!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance==='undefined'){showToast('Text-to-speech is not available in this browser.');return}
  const paras=$$('#readingPage p').map(p=>(p.textContent||'').trim());
  if(!paras.some(Boolean)){showToast('There is no text to read in this chapter.');return}

  const token=++state.playbackToken;
  try{speechSynthesis.cancel()}catch{}
  speechSynthesis.resume();

  let pIndex=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  pIndex=Math.max(0,Math.min(pIndex,paras.length-1));
  let firstOffset=fromSelected?(state.selectedCharOffset||0):0;

  state.isSpeaking=true;state.isPaused=false;
  requestWakeLock();
  const st=$('#voiceStatus');
  if(st)st.textContent=state.chapterTransitionNotice||'Starting…';
  state.chapterTransitionNotice='';
  const play=$('#playBtn');if(play){play.textContent='Ⅱ';play.setAttribute('aria-label','Pause')}
  const replay=$('#replayBtn');if(replay)replay.disabled=true;

  const currentVoice=()=>{
    const p=prefs(),selectedKey=$('#voiceSelect')?.value||p.voiceKey;
    const visibleEnglish=state.voices.filter(x=>/^en(?:-|_)/i.test(x.lang||'')&&!(p.hiddenVoiceKeys||[]).includes(voiceKey(x))&&!(p.hiddenVoices||[]).includes(x.name));
    return visibleEnglish.find(x=>voiceKey(x)===selectedKey)||
      visibleEnglish.find(x=>x.name===p.voiceName)||
      visibleEnglish.find(x=>x.name==='Samantha')||
      visibleEnglish[0]||null;
  };

  const continueChapter=async()=>{
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const book=await idbGet('books',state.bookId);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    if(!book){finishSpeech(token);return}
    if(state.chapterIndex>=book.chapters.length-1){await saveProgress(book,{completed:true});finishSpeech(token);return}
    if(prefs().autoAdvance===false){finishSpeech(token);return}
    const completedLabel=chapterLabel(book.chapters[state.chapterIndex],book);
    state.chapterIndex++;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;state.speakingParagraph=null;
    await saveProgress(book);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const notice=`${completedLabel} complete · continuing to ${chapterLabel(book.chapters[state.chapterIndex],book)}…`;
    state.chapterTransitionNotice=notice;
    showToast(notice);
    await renderReader();
    if(token!==state.playbackToken||!state.isSpeaking)return;
    startSpeech(false);
  };

  const speakParagraph=()=>{
    if(token!==state.playbackToken||!state.isSpeaking)return;
    if(pIndex>=paras.length){continueChapter();return}
    const full=paras[pIndex];
    const start=(pIndex===state.selectedParagraph?firstOffset:0);
    if(start>=full.length){pIndex++;firstOffset=0;speakParagraph();return}
    const segments=sentenceSegments(full,start);
    let sIndex=0;
    state.speakingParagraph=pIndex;state.selectedParagraph=pIndex;
    state.speakingPIndex=pIndex;state.speakingSIndex=0;state.speakingSegments=segments;
    markSpeaking(pIndex);
    const range=$('#positionRange');if(range)range.value=pIndex;
    const label=$('#positionLabel');if(label)label.textContent=`Paragraph ${pIndex+1} of ${paras.length}`;

    const speakSentence=()=>{
      if(token!==state.playbackToken||!state.isSpeaking)return;
      if(sIndex>=segments.length){
        const currentP=$(`#readingPage p[data-p="${pIndex}"]`);if(currentP)currentP.textContent=full;
        state.selectedCharOffset=full.length;state.selectedWordEnd=full.length;
        persistReadingProgress();
        pIndex++;firstOffset=0;speakParagraph();return;
      }

      const seg=segments[sIndex];
      state.speakingPIndex=pIndex;state.speakingSIndex=sIndex;state.speakingSegments=segments;
      const startWord=wordRangeAt(full,seg.start);
      state.selectedCharOffset=seg.start;state.selectedWordEnd=startWord.end;
      persistReadingProgress();
      highlightRange(pIndex,seg.start,seg.end);
      if(st)st.textContent=`Reading paragraph ${pIndex+1} · sentence ${sIndex+1}/${segments.length}`;
      if(replay)replay.disabled=false;

      const speakUtterance=(text,onDone)=>{
        const u=new SpeechSynthesisUtterance(text);
        state.activeUtterance=u;
        const p=prefs(),v=currentVoice();
        u.rate=+(p.rate||1.05);u.volume=1;u.pitch=1;
        if(v){u.voice=v;u.lang=v.lang}else{u.lang=navigator.language||'en-US'}
        u.onstart=()=>{if(token===state.playbackToken&&state.activeUtterance===u)requestWakeLock()};
        u.onend=()=>{
          if(token!==state.playbackToken||state.activeUtterance!==u)return;
          state.activeUtterance=null;onDone();
        };
        u.onerror=e=>{
          if(token!==state.playbackToken||state.activeUtterance!==u)return;
          state.activeUtterance=null;
          if(e.error==='canceled'||e.error==='interrupted')return;
          showToast('The device voice could not continue.');finishSpeech(token);
        };
        speechSynthesis.speak(u);
      };

      state.replayCurrent=()=>{
        if(token!==state.playbackToken||!state.isSpeaking)return;
        state.isPaused=false;
        const playBtn=$('#playBtn');if(playBtn){playBtn.textContent='Ⅱ';playBtn.setAttribute('aria-label','Pause')}
        try{speechSynthesis.cancel()}catch{}
        speechSynthesis.resume();
        speakUtterance(seg.text,()=>{sIndex++;speakSentence()});
      };

      speakUtterance(seg.text,()=>{sIndex++;speakSentence()});
    };
    speakSentence();
  };
  speakParagraph();
}
function replayCurrentSentence(){
  if(!state.isSpeaking||!state.replayCurrent){showToast('Start reading first.');return}
  state.replayCurrent();
}
function stopAllSpeech(){
  state.playbackToken++;
  try{speechSynthesis.cancel()}catch{}
  try{if(window.meSpeak)meSpeak.stop()}catch{}
  state.isSpeaking=false;state.isPaused=false;state.activeUtterance=null;state.localSpeakingId=null;state.speakingParagraph=null;
  state.speakingPIndex=null;state.speakingSIndex=null;state.speakingSegments=null;state.replayCurrent=null;
  clearSleepTimer();releaseWakeLock();
  const b=$('#playBtn');if(b){b.textContent='▶';b.setAttribute('aria-label','Play')}
  const replay=$('#replayBtn');if(replay)replay.disabled=true;
  const st=$('#voiceStatus');if(st)st.textContent='Device voice ready';
  $$('#readingPage p').forEach(p=>p.classList.remove('speaking'));clearSentenceHighlights();
}
function ensureLocalTTS(){
  if(state.localTTSReady && window.meSpeak) return Promise.resolve();
  if(window.__storylineLocalTTSLoading) return window.__storylineLocalTTSLoading;
  const base='https://cdn.jsdelivr.net/gh/btopro/mespeak@master/';
  const loader=new Promise((resolve,reject)=>{
    const finish=()=>{
      try{
        meSpeak.loadConfig(base+'mespeak_config.json', ok=>{
          if(ok===false){ reject(new Error('Local speech configuration did not load.')); return; }
          meSpeak.loadVoice(base+'voices/en/en-us.json',(success,msg)=>{
            if(!success){ reject(new Error('Local English voice did not load: '+msg)); return; }
            state.localTTSReady=true; resolve();
          });
        });
      }catch(e){reject(e)}
    };
    if(window.meSpeak){ finish(); return; }
    const script=document.createElement('script');
    script.src=base+'mespeak.js'; script.async=true;
    script.onload=finish; script.onerror=()=>reject(new Error('Could not download the free local speech engine.'));
    document.head.appendChild(script);
  });
  const timeout=new Promise((_,reject)=>setTimeout(()=>reject(new Error('The experimental local voice did not load. Please use Device voice.')),8000));
  window.__storylineLocalTTSLoading=Promise.race([loader,timeout]).catch(e=>{window.__storylineLocalTTSLoading=null;throw e});
  return window.__storylineLocalTTSLoading;
}
function localSpeed(){
  const rate=+(prefs().rate||1.05);
  return Math.max(90,Math.min(310,Math.round(170*rate)));
}
function highlightSentence(paragraphIndex,sentenceIndex,sentences){
  const p=$(`#readingPage p[data-p="${paragraphIndex}"]`);
  if(!p)return;
  p.innerHTML=sentences.map((sentence,i)=>`<span class="${i===sentenceIndex?'sentence-speaking':''}">${escapeHtml(sentence)}</span>`).join(' ');
}
function clearSentenceHighlights(){
  $$('#readingPage p').forEach(p=>{
    if(p.querySelector('.sentence-speaking')) p.textContent=p.textContent;
  });
}
async function startLocalSpeech(fromSelected=true){
  const paras=$$('#readingPage p').map(p=>(p.textContent||'').trim());
  if(!paras.some(Boolean)){showToast('There is no text to read in this chapter.');return}
  let pIndex=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  pIndex=Math.max(0,Math.min(pIndex,paras.length-1));
  const st=$('#voiceStatus'); if(st)st.textContent=state.chapterTransitionNotice||'Loading free local voice…';
  state.chapterTransitionNotice='';
  const play=$('#playBtn'); if(play)play.textContent='…';
  try{await ensureLocalTTS();}catch(e){if(st)st.textContent='Local voice failed to load';if(play)play.textContent='▶';showToast(e.message);return}
  try{meSpeak.stop();}catch{}
  state.isSpeaking=true; state.isPaused=false;
  requestWakeLock();
  if(play){play.textContent='■';play.setAttribute('aria-label','Stop');}

  const continueLocalChapter=async()=>{
    if(!state.isSpeaking)return;
    const book=await idbGet('books',state.bookId);
    if(!state.isSpeaking)return;
    if(!book){finishSpeech();return}
    if(state.chapterIndex>=book.chapters.length-1){await saveProgress(book,{completed:true});finishSpeech();return}
    if(prefs().autoAdvance===false){finishSpeech();return}
    const completedLabel=chapterLabel(book.chapters[state.chapterIndex],book);
    state.chapterIndex++;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;state.speakingParagraph=null;
    await saveProgress(book);
    if(!state.isSpeaking)return;
    const notice=`${completedLabel} complete · continuing to ${chapterLabel(book.chapters[state.chapterIndex],book)}…`;
    state.chapterTransitionNotice=notice;
    showToast(notice);
    await renderReader();
    if(!state.isSpeaking)return;
    startLocalSpeech(false);
  };

  const speakParagraph=()=>{
    if(!state.isSpeaking)return;
    if(pIndex>=paras.length){continueLocalChapter();return}
    const sentences=splitSentences(paras[pIndex]);
    let sIndex=0;
    state.speakingParagraph=pIndex; state.selectedParagraph=pIndex; markSpeaking(pIndex);
    const range=$('#positionRange'); if(range)range.value=pIndex;
    const label=$('#positionLabel'); if(label)label.textContent=`Paragraph ${pIndex+1} of ${paras.length}`;

    const speakSentence=()=>{
      if(!state.isSpeaking)return;
      if(sIndex>=sentences.length){
        const currentP=$(`#readingPage p[data-p="${pIndex}"]`); if(currentP) currentP.textContent=paras[pIndex];
        state.selectedCharOffset=0;state.selectedWordEnd=0;
        idbGet('books',state.bookId).then(book=>book&&saveProgress(book)).catch(()=>{});
        pIndex++; speakParagraph(); return;
      }
      if(st)st.textContent=`Reading paragraph ${pIndex+1} · sentence ${sIndex+1}/${sentences.length}`; highlightSentence(pIndex,sIndex,sentences);
      const id=meSpeak.speak(sentences[sIndex],{amplitude:100,speed:localSpeed(),volume:1,voice:'en-us',variant:localVoiceVariant()},success=>{
        state.localSpeakingId=null;
        if(!state.isSpeaking)return;
        if(!success){finishSpeech();return}
        sIndex++; speakSentence();
      });
      if(!id){showToast('The local voice could not generate this sentence.');finishSpeech();return}
      state.localSpeakingId=id;
    };
    speakSentence();
  };
  speakParagraph();
}
function testSelectedVoice(){
  testVoice();
}
async function testLocalVoice(){
  const st=$('#voiceStatus');if(st)st.textContent='Loading free local voice…';
  try{
    await ensureLocalTTS();
    try{meSpeak.stop()}catch{}
    const id=meSpeak.speak('Storyline Studio local voice test.',{amplitude:100,speed:170,volume:1,voice:'en-us',variant:localVoiceVariant()},success=>{
      state.localSpeakingId=null;if(st)st.textContent=success?'Local test finished':'Local test stopped';showToast(success?'Local voice test finished':'Local voice test stopped');
    });
    state.localSpeakingId=id;
    if(st)st.textContent=id?'Local test is speaking':'Local voice could not start';
    if(!id)showToast('Local voice could not start');
  }catch(e){if(st)st.textContent='Local voice failed';showToast(e.message)}
}
async function testSound(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC){ showToast('Audio test is not available in this browser.'); return; }
  try{
    const ctx=new AC();
    if(ctx.state==='suspended') await ctx.resume();
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.value=880;
    gain.gain.setValueAtTime(0.0001,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18,ctx.currentTime+0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.65);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime+0.7);
    const st=$('#voiceStatus'); if(st) st.textContent='Playing test tone…';
    osc.onended=()=>{ if(st) st.textContent='Test sound finished'; ctx.close().catch(()=>{}); };
  }catch(e){ const st=$('#voiceStatus'); if(st) st.textContent='Sound error'; showToast('Sound test could not start.'); }
}
function testVoice(){
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  stopAllSpeech();
  const p=prefs(); const selectedKey=$('#voiceSelect')?.value||p.voiceKey;
  const v=state.voices.find(x=>voiceKey(x)===selectedKey) || state.voices.find(x=>x.name===p.voiceName) || state.voices.find(x=>x.lang==='en-US') || state.voices[0];
  const u=new SpeechSynthesisUtterance('Storyline Studio voice test.');
  state.activeUtterance=u;
  u.volume=1; u.rate=1; u.pitch=1;
  if(v){ u.voice=v; u.lang=v.lang; } else { u.lang='en-US'; }
  const st=$('#voiceStatus');
  if(st) st.textContent='Testing…';
  u.onstart=()=>{if(state.activeUtterance!==u)return;if(st)st.textContent='Test is speaking';showToast('Voice test started')};
  u.onend=()=>{if(state.activeUtterance!==u)return;state.activeUtterance=null;if(st)st.textContent='Test finished';showToast('Voice test finished')};
  u.onerror=e=>{if(state.activeUtterance!==u)return;state.activeUtterance=null;if(e.error==='canceled'||e.error==='interrupted')return;if(st)st.textContent='Voice error: '+(e.error||'unknown');showToast('Voice error: '+(e.error||'unknown'))};
  speechSynthesis.resume();
  speechSynthesis.speak(u);
}
function markSpeaking(i){
  $$('#readingPage p').forEach(p=>p.classList.toggle('speaking',+p.dataset.p===i));
  const el=$(`#readingPage p[data-p="${i}"]`);
  if(el) el.scrollIntoView({block:'center',behavior:'smooth'});
  const st=$('#voiceStatus');
  if(st) st.textContent=`Reading paragraph ${i+1}`;
}
function finishSpeech(token=null){
  if(token!==null&&token!==state.playbackToken)return;
  state.isSpeaking=false;state.isPaused=false;state.speakingParagraph=null;state.activeUtterance=null;state.localSpeakingId=null;
  state.speakingPIndex=null;state.speakingSIndex=null;state.speakingSegments=null;state.replayCurrent=null;
  clearSleepTimer();releaseWakeLock();
  const b=$('#playBtn');if(b){b.textContent='▶';b.setAttribute('aria-label','Play')}
  const replay=$('#replayBtn');if(replay)replay.disabled=true;
  $$('#readingPage p').forEach(p=>p.classList.remove('speaking'));clearSentenceHighlights();
  const st=$('#voiceStatus');if(st)st.textContent='Device voice ready';
}

function attachDictation(button,textarea){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!button||!textarea)return;
  if(!SR){button.disabled=true;button.textContent='Dictation unavailable';return}
  let recognition=null,active=false,baseText='';
  button.onclick=()=>{
    if(active){try{recognition.stop()}catch{}return}
    recognition=new SR(); recognition.continuous=true; recognition.interimResults=true; recognition.lang='en-US';
    baseText=textarea.value.trim(); let final='';
    recognition.onstart=()=>{active=true;button.textContent='■ Stop dictating'};
    recognition.onresult=e=>{
      let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0].transcript;
        if(e.results[i].isFinal)final+=t+' '; else interim+=t;
      }
      textarea.value=[baseText,(final+interim).trim()].filter(Boolean).join(baseText?' ':'');
    };
    recognition.onend=()=>{active=false;button.textContent='🎙 Dictate'};
    recognition.onerror=()=>{active=false;button.textContent='🎙 Dictate';showToast('Dictation stopped. You can keep typing.')};
    try{recognition.start()}catch{}
  };
}
function chooseAudioMime(){
  if(!window.MediaRecorder)return '';
  const types=['audio/mp4','audio/webm;codecs=opus','audio/webm'];
  return types.find(t=>MediaRecorder.isTypeSupported?.(t))||'';
}
async function handleAction(act,book,ch){ const text=ch.paragraphs[state.selectedParagraph]||''; const base={bookId:book.id,bookTitle:book.title,chapterIndex:state.chapterIndex,chapterTitle:chapterLabel(ch,book),paragraphIndex:state.selectedParagraph,charOffset:state.selectedCharOffset||0,wordEnd:state.selectedWordEnd||0,excerpt:excerpt(text),createdAt:new Date().toISOString(),status:'open'};
  if(act==='start'){ startSpeech(true); return} if(act==='queue'){navigate('queue');return}
  if(act==='bookmark'){await idbPut('items',{...base,id:uid(),type:'bookmark',note:''});showToast('Bookmarked');updateQueueBadge();return}
  if(act==='note') return promptItem('note','Add note','What did you notice?',base);
  if(act==='continuity') return promptItem('continuity','Flag continuity','What seems inconsistent or needs checking?',base);
  if(act==='ask') return promptItem('question','Ask ChatGPT later','What do you want me to check, explain, or revise?',base);
  if(act==='voice') return voiceNote(base);
}
function promptItem(type,title,placeholder,base){
  modalForm.innerHTML=`<h3>${title}</h3><div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1}</div><div class="excerpt">${escapeHtml(base.excerpt)}</div><textarea id="itemText" placeholder="${escapeHtml(placeholder)}" autofocus></textarea><div class="row between"><button value="cancel" class="button secondary">Cancel</button><div class="row"><button type="button" id="dictateItem" class="ghost">🎙 Dictate</button><button id="saveItem" value="default" class="button">Save</button></div></div>`;
  modal.showModal();
  attachDictation($('#dictateItem'),$('#itemText'));
  setTimeout(()=>$('#itemText')?.focus(),50);
  $('#saveItem').onclick=async e=>{e.preventDefault();const note=$('#itemText').value.trim(); if(!note){showToast('Add a note first');return} await idbPut('items',{...base,id:uid(),type,note}); modal.close(); showToast(type==='question'?'Added to revision queue':'Saved'); updateQueueBadge();};
}
async function voiceNote(base){
  const canRecord=!!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let stream=null,recorder=null,chunks=[],audioBlob=null,previewUrl=null,recording=false,recordStartedAt=0,audioDurationSec=0,timer=null;

  modalForm.innerHTML=`<h3>Voice note</h3>
    <div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1}</div>
    <div class="excerpt">${escapeHtml(base.excerpt)}</div>
    <div id="voiceRecordStatus" class="sub">${canRecord?'Record an audio note. It stays in this browser.':'Audio recording is not available in this browser.'}</div>
    <div id="recordTimer" class="record-timer">0:00</div>
    <audio id="voicePreview" class="voice-preview hidden" controls></audio>
    <textarea id="voiceCaption" placeholder="Optional typed caption"></textarea>
    <div class="voice-note-actions">
      <button value="cancel" class="button secondary">Cancel</button>
      <button type="button" id="recordAudioBtn" class="ghost" ${canRecord?'':'disabled'}>● Record</button>
      <button type="button" id="saveAudioNote" class="button">Save voice note</button>
    </div>`;
  modal.showModal();

  const setPreview=blob=>{
    audioBlob=blob;
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(audioBlob);
    const a=$('#voicePreview'); a.src=previewUrl; a.classList.remove('hidden');
  };
  const stopTimer=()=>{if(timer){clearInterval(timer);timer=null}};
  const cleanup=()=>{
    stopTimer();
    try{if(recorder&&recorder.state!=='inactive')recorder.stop()}catch{}
    try{stream?.getTracks().forEach(t=>t.stop())}catch{}
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null}
  };
  modal.onclose=cleanup;

  const recordBtn=$('#recordAudioBtn');
  if(recordBtn)recordBtn.onclick=async()=>{
    if(recording){
      try{recorder.requestData()}catch{}
      setTimeout(()=>{try{if(recorder&&recorder.state!=='inactive')recorder.stop()}catch{}},100);
      return;
    }
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      chunks=[]; audioBlob=null; audioDurationSec=0;
      recorder=new MediaRecorder(stream);
      recorder.ondataavailable=e=>{if(e.data&&e.data.size>0)chunks.push(e.data)};
      recorder.onstart=()=>{
        recording=true;recordStartedAt=Date.now();
        recordBtn.textContent='■ Stop recording';
        $('#voiceRecordStatus').textContent='Recording audio…';
        const timerEl=$('#recordTimer');
        timer=setInterval(()=>{if(timerEl)timerEl.textContent=formatDuration((Date.now()-recordStartedAt)/1000)},250);
      };
      recorder.onstop=()=>{
        recording=false;stopTimer();
        audioDurationSec=recordStartedAt?Math.max(1,Math.round((Date.now()-recordStartedAt)/1000)):0;
        recordBtn.textContent='● Record again';
        try{stream?.getTracks().forEach(t=>t.stop())}catch{}
        const type=recorder.mimeType||chunks.find(c=>c.type)?.type||'audio/mp4';
        const blob=new Blob(chunks,{type});
        if(!blob.size){
          $('#voiceRecordStatus').textContent='No audio was captured. Please try again.';
          showToast('No audio was captured.');
          return;
        }
        setPreview(blob);
        $('#voiceRecordStatus').textContent=`Recorded · ${formatDuration(audioDurationSec)}. Play it back before saving if you want.`;
      };
      recorder.onerror=()=>{
        recording=false;stopTimer();recordBtn.textContent='● Record again';
        $('#voiceRecordStatus').textContent='Recording failed. Please try again.';
      };
      recorder.start(250);
    }catch(e){
      recording=false;stopTimer();
      $('#voiceRecordStatus').textContent='Microphone recording was not available.';
      showToast('Microphone recording was not available.');
    }
  };

  $('#saveAudioNote').onclick=async()=>{
    if(recording){showToast('Stop the recording before saving.');return}
    if(!audioBlob){showToast('Record something first.');return}
    const btn=$('#saveAudioNote'); btn.disabled=true; btn.textContent='Saving…';
    try{
      const audioData=await audioBlob.arrayBuffer();
      const note=$('#voiceCaption').value.trim();
      await idbPut('items',{...base,id:uid(),type:'voice',note,voice:true,audioData,audioType:audioBlob.type||'audio/mp4',durationSec:audioDurationSec});
      modal.onclose=null; cleanup(); modal.close(); showToast('Voice note saved'); updateQueueBadge();
    }catch(e){
      btn.disabled=false;btn.textContent='Save voice note';
      $('#voiceRecordStatus').textContent='The recording could not be saved. Please try again.';
      showToast('Voice note could not be saved.');
    }
  };
}

async function renderNotes(){ const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b])); const items=(await idbGetAll('items')).filter(i=>['note','bookmark','voice'].includes(i.type)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  view.innerHTML=`<section class="hero"><div class="eyebrow">Listening memory</div><h1>Notes & bookmarks</h1><p class="sub">Everything you caught while listening, still attached to where you heard it.</p></section>${items.length?`<div class="list">${items.map(i=>itemHtml(i,bookMap)).join('')}</div>`:`<div class="empty card">No notes yet. This is suspiciously peaceful.</div>`}`; wireItemButtons(); }
async function renderQueue(){
  const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b]));
  const all=(await idbGetAll('items')).filter(i=>['question','continuity','note','bookmark','voice'].includes(i.type));
  const pending=all.filter(i=>i.status!=='done').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const actionedCount=all.filter(i=>i.status==='done').length;

  view.innerHTML=`<section class="hero"><div class="eyebrow">Revision desk</div><h1>Revision Queue</h1><p class="sub">Pending items stay here until you action them.</p></section>
    <div class="stat-grid"><div class="stat"><b>${pending.length}</b><small>Pending</small></div><div class="stat"><b>${pending.filter(i=>i.type==='continuity').length}</b><small>Continuity</small></div><button class="stat stat-button" data-nav-inline="actioned"><b>${actionedCount}</b><small>Actioned</small></button></div>
    <section class="queue-section">
      ${pending.length?`<div class="queue-toolbar">
        <label class="queue-select-all"><input id="selectAllQueue" type="checkbox" /> <span>Select all</span></label>
        <span id="selectedCount" class="meta">0 selected</span>
        <div class="queue-bulk-actions">
          <button id="copyAllPending" class="ghost tiny">Copy all pending</button>
          <button id="bulkDone" class="ghost tiny" disabled>Mark selected done</button>
          <button id="bulkCopy" class="ghost tiny" disabled>Copy selected for ChatGPT</button>
          <button id="bulkDelete" class="ghost tiny danger-ghost" disabled>Delete selected</button>
        </div>
      </div><div class="list queue-list">${pending.map(i=>itemHtml(i,bookMap,true,false)).join('')}</div>`:`<div class="empty card">Nothing pending.</div>`}
    </section>`;

  wireItemButtons();
  wireQueueBulk();
  const copyAll=$('#copyAllPending');if(copyAll)copyAll.onclick=()=>copyItemsForChat(pending);
  const actionedLink=$('[data-nav-inline="actioned"]'); if(actionedLink)actionedLink.onclick=()=>navigate('actioned');
}
async function renderActioned(){
  const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b]));
  const items=(await idbGetAll('items')).filter(i=>['question','continuity','note','bookmark','voice'].includes(i.type)&&i.status==='done').sort((a,b)=>new Date(b.completedAt||b.createdAt)-new Date(a.completedAt||a.createdAt));
  view.innerHTML=`<section class="hero"><div class="eyebrow">Completed log</div><h1>Actioned</h1><p class="sub">Completed revision items stay here until you reopen or delete them.</p></section>
    <div class="row between actioned-page-heading"><span class="meta">${items.length} completed</span><button class="ghost tiny" id="backToQueue">Back to Queue</button></div>
    ${items.length?`<div class="list actioned-list">${items.map(i=>itemHtml(i,bookMap,true,true)).join('')}</div>`:`<div class="empty card">No actioned items yet.</div>`}`;
  $('#backToQueue').onclick=()=>navigate('queue');
  wireItemButtons();
}
function itemHtml(i,bookMap,queue=false,actioned=false){
  const label=i.type==='question'?'Ask ChatGPT':i.type==='continuity'?'Continuity':i.type==='bookmark'?'Bookmark':i.type==='voice'?'Voice note':'Note';
  const pill=i.status==='done'?'green':i.type==='question'||i.type==='continuity'?'gold':'';
  const hasAudio=!!(i.audioData||i.audioBlob);
  const timeText=actioned?`Actioned ${formatItemTime(i.completedAt||i.createdAt)}`:formatItemTime(i.createdAt);
  return `<article class="list-item ${actioned?'item-done':''}" data-item="${i.id}">
    <div class="row between">
      <div class="row">${queue&&!actioned?`<input class="queue-item-check" type="checkbox" data-select-item="${i.id}" aria-label="Select item" />`:''}<span class="pill ${pill}">${label}</span></div>
      <span class="meta item-time">${timeText}${i.durationSec?` · ${formatDuration(i.durationSec)}`:''}</span>
    </div>
    <div><strong>${escapeHtml(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript')}</strong><div class="source-chip">${escapeHtml((i.chapterTitle==='Beginning'||i.chapterTitle==='Front matter')?(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript'):(i.chapterTitle||'Chapter'))} · paragraph ${(i.paragraphIndex??0)+1}</div></div>
    <div class="excerpt">${escapeHtml(i.excerpt||'')}</div>
    ${i.note?`<div class="note-text">${escapeHtml(i.note)}</div>`:''}
    ${hasAudio?`<audio class="saved-voice-note" controls data-audio-item="${i.id}"></audio>`:''}
    <div class="row">
      <button data-open-item="${i.id}" class="ghost tiny">Open passage</button>
      ${queue?`<button data-copy="${i.id}" class="ghost tiny">Copy for ChatGPT</button><button data-done="${i.id}" class="ghost tiny">${actioned?'Reopen':'Mark done'}</button>`:''}
      <button data-delete-item="${i.id}" class="ghost tiny danger-ghost">Delete</button>
    </div>
  </article>`;
}
function chatPacket(i){
  const audioNote=i.type==='voice'?'\nAudio: Voice-note audio is stored in Storyline and is not included in clipboard text.':'';
  return `Storyline Studio revision item\n\nBook: ${i.bookTitle}\nLocation: ${i.chapterTitle}, paragraph ${(i.paragraphIndex||0)+1}\nType: ${i.type}\nCreated: ${formatItemTime(i.createdAt)}\n\nPassage:\n${i.excerpt||''}\n\nMy note/question:\n${i.note||''}${audioNote}\n\nPlease answer using the manuscript context I provide, and do not revise the manuscript unless I explicitly ask.`;
}
async function copyItemsForChat(items){
  if(!items.length)return;
  const text=items.map((i,n)=>`--- Item ${n+1} of ${items.length} ---\n${chatPacket(i)}`).join('\n\n');
  try{await navigator.clipboard.writeText(text);showToast(items.length===1?'Copied for ChatGPT':`Copied ${items.length} items for ChatGPT`)}catch{showToast('Copy was blocked by the browser')}
}
function selectedQueueIds(){return $$('.queue-item-check:checked').map(c=>c.dataset.selectItem)}
function updateBulkBar(){
  const ids=selectedQueueIds(); const count=$('#selectedCount'); if(count)count.textContent=`${ids.length} selected`;
  ['#bulkDone','#bulkCopy','#bulkDelete'].forEach(sel=>{const b=$(sel);if(b)b.disabled=!ids.length});
  const all=$$('.queue-item-check'); const selectAll=$('#selectAllQueue');
  if(selectAll){selectAll.checked=!!all.length&&ids.length===all.length;selectAll.indeterminate=ids.length>0&&ids.length<all.length}
}
function wireQueueBulk(){
  const selectAll=$('#selectAllQueue'); if(!selectAll)return;
  selectAll.onchange=()=>{$$('.queue-item-check').forEach(c=>c.checked=selectAll.checked);updateBulkBar()};
  $$('.queue-item-check').forEach(c=>c.onchange=updateBulkBar);
  $('#bulkDone').onclick=async()=>{
    const ids=selectedQueueIds(); if(!ids.length)return;
    if(!confirm(`Mark ${ids.length} selected item${ids.length===1?'':'s'} as done?`))return;
    for(const id of ids){const i=await idbGet('items',id);if(i){i.status='done';i.completedAt=new Date().toISOString();await idbPut('items',i)}}
    navigate('queue');
  };
  $('#bulkCopy').onclick=async()=>{
    const ids=selectedQueueIds(); const items=[];
    for(const id of ids){const i=await idbGet('items',id);if(i)items.push(i)}
    await copyItemsForChat(items);
  };
  $('#bulkDelete').onclick=async()=>{
    const ids=selectedQueueIds(); if(!ids.length)return;
    if(!confirm(`Delete ${ids.length} selected item${ids.length===1?'':'s'}? This cannot be undone.`))return;
    for(const id of ids)await idbDelete('items',id);
    navigate('queue');
  };
  updateBulkBar();
}
function wireItemButtons(){
  $$('[data-audio-item]').forEach(async a=>{
    const i=await idbGet('items',a.dataset.audioItem);
    let blob=null;
    if(i?.audioData)blob=new Blob([i.audioData],{type:i.audioType||'audio/mp4'});
    else if(i?.audioBlob)blob=i.audioBlob;
    if(blob){const u=URL.createObjectURL(blob);savedAudioObjectUrls.add(u);a.src=u;a.dataset.objectUrl=u;}
  });
  $$('[data-open-item]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.openItem);
    if(!i)return;
    const book=await idbGet('books',i.bookId);
    if(!book){showToast('That manuscript is no longer in this browser.');return}
    state.bookId=i.bookId; state.chapterIndex=i.chapterIndex??0; state.selectedParagraph=i.paragraphIndex??0;
    state.selectedCharOffset=i.charOffset??0; state.selectedWordEnd=i.wordEnd??0;
    savePrefs({lastBookId:state.bookId}); await saveProgress(book); navigate('reader');
  });
  $$('[data-delete-item]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.deleteItem); if(!i)return;
    if(!confirm('Delete this item? This cannot be undone.'))return;
    await idbDelete('items',i.id); navigate(state.route);
  });
  $$('[data-done]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.done); if(!i)return;
    if(i.status==='done'){
      i.status='open'; i.completedAt=null; await idbPut('items',i); navigate('actioned'); return;
    }
    if(!confirm('Mark this item as done?'))return;
    i.status='done'; i.completedAt=new Date().toISOString(); await idbPut('items',i); navigate('queue');
  });
  $$('[data-copy]').forEach(b=>b.onclick=async()=>{const i=await idbGet('items',b.dataset.copy);if(i)await copyItemsForChat([i])});
}

$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
$$('[data-reader-act]').forEach(b=>b.addEventListener('click',async()=>{
  if(state.route!=='reader'||!state.bookId)return;
  document.body.classList.remove('mobile-tools-open');
  if(b.dataset.readerAct==='start'){ startSpeech(true); return; }
  const book=await idbGet('books',state.bookId); if(!book)return;
  const ch=book.chapters[state.chapterIndex]; if(!ch)return;
  await handleAction(b.dataset.readerAct,book,ch);
}));
const readerToolsToggle=$('#readerToolsToggle');
if(readerToolsToggle)readerToolsToggle.addEventListener('click',()=>document.body.classList.toggle('mobile-tools-open'));
const navCollapse=$('#navCollapse');
function applyNavCollapse(){
  const collapsed=!!prefs().navCollapsed;
  document.body.classList.toggle('nav-collapsed',collapsed);
  if(navCollapse){navCollapse.setAttribute('aria-expanded',String(!collapsed));const small=navCollapse.querySelector('small');if(small)small.textContent=collapsed?'Expand':'Collapse';const icon=navCollapse.querySelector('span');if(icon)icon.textContent=collapsed?'›':'‹';}
}
if(navCollapse)navCollapse.onclick=()=>{savePrefs({navCollapsed:!prefs().navCollapsed});applyNavCollapse()};
applyNavCollapse();
fileInput.addEventListener('change',e=>{importFile(e.target.files[0]);e.target.value=''});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredPrompt=e;$('#installBtn').classList.remove('hidden')});
$('#installBtn').onclick=async()=>{if(state.deferredPrompt){state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null;$('#installBtn').classList.add('hidden')}};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state.isSpeaking)requestWakeLock()});
window.addEventListener('pagehide',()=>stopAllSpeech());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

openDB().then(async()=>{ let p=prefs(); if(p.engine!=='device'){ savePrefs({engine:'device'}); p=prefs(); } state.bookId=p.lastBookId||null; if(state.bookId){ const b=await idbGet('books',state.bookId); if(b){ state.chapterIndex=b.progress?.chapterIndex ?? p.lastChapterIndex ?? 0; state.selectedParagraph=b.progress?.paragraphIndex ?? p.lastParagraphIndex ?? 0; state.selectedCharOffset=b.progress?.charOffset ?? p.lastCharOffset ?? 0; state.selectedWordEnd=b.progress?.wordEnd ?? p.lastWordEnd ?? 0; } } await navigate('library'); }).catch(e=>{view.innerHTML=`<div class="empty">Storyline could not start: ${escapeHtml(e.message)}</div>`});
})();