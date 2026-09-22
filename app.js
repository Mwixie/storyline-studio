(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const view = $('#view'), fileInput = $('#fileInput'), modal = $('#modal'), modalForm = $('#modalForm'), toast = $('#toast');

const state = {
  route:'library', bookId:null, chapterIndex:0, selectedParagraph:0, selectedCharOffset:0, selectedWordEnd:0, speakingParagraph:null,
  voices:[], isSpeaking:false, isPaused:false, deferredPrompt:null, activeUtterance:null, localSpeakingId:null, localTTSReady:false
};

const PREF='storyline.prefs.v1';
const dbName='storyline-studio';
let db;

function showToast(msg){ toast.textContent=msg; toast.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>toast.classList.remove('show'),2200); }
function uid(){ return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2); }
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function prefs(){ try{return JSON.parse(localStorage.getItem(PREF)||'{}')}catch{return{}} }
function savePrefs(patch){ localStorage.setItem(PREF,JSON.stringify({...prefs(),...patch})); }
function isIOS(){ return /iPhone|iPad|iPod/i.test(navigator.userAgent||''); }
function currentEngine(){ return 'device'; }
function localVoiceVariant(){ const v=prefs().localVariant||'f2'; return ['f2','f3','m3'].includes(v)?v:'f2'; }
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
function idbPut(name,obj){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(obj);r.onsuccess=()=>res(obj);r.onerror=()=>rej(r.error)})}
function idbDelete(name,id){return new Promise((res,rej)=>{const r=store(name,'readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

function splitChapters(paragraphs){
  const chapters=[]; let current={title:'Beginning', paragraphs:[]};
  const heading=/^(chapter\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[a-z-]+)|prologue|epilogue)\b/i;
  for(const raw of paragraphs){ const p=raw.trim(); if(!p) continue;
    if(heading.test(p) && current.paragraphs.length){ chapters.push(current); current={title:p,paragraphs:[]}; }
    else if(heading.test(p) && !current.paragraphs.length){ current.title=p; }
    else current.paragraphs.push(p);
  }
  if(current.paragraphs.length) chapters.push(current);
  if(!chapters.length) chapters.push({title:'Manuscript',paragraphs:paragraphs.filter(Boolean)});
  return chapters;
}

async function parseDocx(file){
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const doc=zip.file('word/document.xml'); if(!doc) throw new Error('This DOCX does not contain a readable document body.');
  const xml=await doc.async('string');
  const dom=new DOMParser().parseFromString(xml,'application/xml');
  const paras=[...dom.getElementsByTagNameNS('*','p')].map(p=>[...p.getElementsByTagNameNS('*','t')].map(t=>t.textContent).join('')).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  return paras;
}
async function importFile(file){
  if(!file) return; let paragraphs;
  try{
    if(file.name.toLowerCase().endsWith('.docx')) paragraphs=await parseDocx(file);
    else paragraphs=(await file.text()).replace(/\r/g,'').split(/\n\s*\n|\n/).map(s=>s.trim()).filter(Boolean);
    if(!paragraphs.length) throw new Error('No manuscript text was found.');
    let title=file.name.replace(/\.(docx|txt)$/i,'').replace(/[_-]+/g,' ').trim();
    const firstUseful=paragraphs.find(p=>p.length>3&&!/^chapter\b/i.test(p));
    if(/the plus[ -]one problem/i.test(title)||/^the plus[ -]one problem/i.test(firstUseful||'')) title='The Plus-One Problem';
    const book={id:uid(),title,fileName:file.name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),chapters:splitChapters(paragraphs),progress:{chapterIndex:0,paragraphIndex:0},version:'Imported manuscript'};
    await idbPut('books',book); state.bookId=book.id; state.chapterIndex=0; state.selectedParagraph=0; savePrefs({lastBookId:book.id}); showToast(`Imported ${book.chapters.length} chapter${book.chapters.length===1?'':'s'}`); navigate('reader');
  }catch(e){showToast(e.message||'Could not import manuscript');}
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
  state.route=route; setNav(route); stopAllSpeech();
  if(route==='library') await renderLibrary(); if(route==='reader') await renderReader(); if(route==='notes') await renderNotes(); if(route==='queue') await renderQueue(); updateQueueBadge();
}

async function renderLibrary(){
  const books=(await idbGetAll('books')).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  const items=await idbGetAll('items');
  view.innerHTML=`
    <section class="hero"><div class="eyebrow">Your private listening desk</div><h1>Read with your ears.<br>Revise with receipts.</h1><p class="sub">Your manuscript stays in this browser. Storyline remembers where you stopped and keeps every note tied to its exact passage.</p></section>
    <section class="import-zone"><strong>${books.length?'Add another manuscript':'Bring in a manuscript'}</strong><p class="sub">DOCX or TXT. Chapter headings are detected automatically.</p><button id="importBtn" class="button">Choose manuscript</button><div class="privacy">Local-first: importing a file does not upload it to a server.</div></section>
    ${books.length?`<h2 class="section-title">My manuscripts</h2><div class="grid books">${books.map(b=>bookCard(b,items)).join('')}</div>`:`<div class="empty">Your library is waiting for its first book.</div>`}
  `;
  $('#importBtn').onclick=()=>fileInput.click();
  $$('.book-card').forEach(c=>c.onclick=async e=>{ if(e.target.closest('[data-delete]')) return; state.bookId=c.dataset.id; savePrefs({lastBookId:state.bookId}); const b=await idbGet('books',state.bookId); state.chapterIndex=b.progress?.chapterIndex||0; state.selectedParagraph=b.progress?.paragraphIndex||0; state.selectedCharOffset=b.progress?.charOffset||0; state.selectedWordEnd=b.progress?.wordEnd||0; navigate('reader'); });
  $$('[data-delete]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=btn.dataset.delete; if(confirm('Remove this manuscript and its saved notes from this device?')){await idbDelete('books',id); const all=await idbGetAll('items'); for(const i of all.filter(x=>x.bookId===id)) await idbDelete('items',i.id); if(state.bookId===id) state.bookId=null; renderLibrary(); updateQueueBadge();}});
}
function bookCard(b,items){ const total=b.chapters.reduce((n,c)=>n+c.paragraphs.length,0); let before=0; for(let i=0;i<(b.progress?.chapterIndex||0);i++) before+=b.chapters[i]?.paragraphs.length||0; before+=b.progress?.paragraphIndex||0; const pct=Math.max(0,Math.min(100,Math.round((before/Math.max(total,1))*100))); const count=items.filter(i=>i.bookId===b.id&&['note','question','continuity'].includes(i.type)).length;
  return `<article class="card book-card" data-id="${b.id}"><div><div class="eyebrow">${escapeHtml(b.version||'Manuscript')}</div><div class="book-title">${escapeHtml(b.title)}</div><p class="meta">${b.chapters.length} chapter${b.chapters.length===1?'':'s'} · ${count} note${count===1?'':'s'}</p></div><div class="stack"><div class="row between"><span class="meta">${pct}% listened</span><button data-delete="${b.id}" class="ghost tiny">Remove</button></div><div class="progress"><i style="width:${pct}%"></i></div><button class="button">Continue reading</button></div></article>`;
}

async function renderReader(){
  const book=await idbGet('books',state.bookId); if(!book){navigate('library');return}
  state.chapterIndex=Math.max(0,Math.min(state.chapterIndex,book.chapters.length-1)); const ch=book.chapters[state.chapterIndex]; state.selectedParagraph=Math.max(0,Math.min(state.selectedParagraph,ch.paragraphs.length-1));
  const p=prefs();
  view.innerHTML=`
    <section class="reader-header"><div class="row between"><div><div class="eyebrow">${escapeHtml(book.title)}</div><h2 class="reader-title">${escapeHtml(ch.title)}</h2></div><button id="backLibrary" class="ghost tiny">Library</button></div>
    <select id="chapterSelect" class="chapter-select">${book.chapters.map((c,i)=>`<option value="${i}" ${i===state.chapterIndex?'selected':''}>${escapeHtml(c.title)}</option>`).join('')}</select></section>
    <article id="readingPage" class="reading-page" aria-label="Manuscript text">${ch.paragraphs.map((t,i)=>`<p data-p="${i}" class="${i===state.selectedParagraph?'selected':''}">${escapeHtml(t)}</p>`).join('')}</article>
    <section class="player compact-player">
      <div class="player-main compact-player-main">
        <div class="transport-buttons">
          <button id="prevBtn" class="ghost transport-skip" aria-label="Previous paragraph">‹</button>
          <button id="playBtn" class="button play" aria-label="Play">▶</button>
          <button id="nextBtn" class="ghost transport-skip" aria-label="Next paragraph">›</button>
        </div>
        <div class="transport-progress"><div class="row between"><span id="positionLabel" class="meta">Paragraph ${state.selectedParagraph+1} of ${ch.paragraphs.length}</span><span id="speedLabel" class="meta">${p.rate||1.05}×</span></div><input id="positionRange" class="range" type="range" min="0" max="${Math.max(ch.paragraphs.length-1,0)}" value="${state.selectedParagraph}" /></div>
      </div>
      <div class="compact-status"><span id="voiceStatus" class="reading-status">Device voice ready</span></div>
      <details id="voiceOptions" class="voice-options">
        <summary><span>Voice & speed</span><span id="voiceSummary" class="meta">Samantha · ${p.rate||1.05}×</span></summary>
        <div class="voice-options-panel">
          <select id="voiceSelect" class="select"><option>Loading voices…</option></select>
          <div class="speed-box"><span class="meta">Speed</span><input id="rateRange" class="range" type="range" min="0.75" max="1.75" step="0.05" value="${p.rate||1.05}" title="Reading speed" /></div>
          <button id="testVoiceBtn" class="ghost tiny">Test selected voice</button>
        </div>
      </details>
    </section>`;
  wireReader(book,ch); loadVoices(); requestAnimationFrame(()=>{ if(state.selectedCharOffset>0) markStartWord(state.selectedParagraph,state.selectedCharOffset,state.selectedWordEnd||state.selectedCharOffset); scrollSelected(false); });
}

function wireReader(book,ch){
  $('#backLibrary').onclick=()=>navigate('library');
  $('#chapterSelect').onchange=async e=>{ state.chapterIndex=+e.target.value; state.selectedParagraph=0; state.selectedCharOffset=0; state.selectedWordEnd=0; await saveProgress(book); renderReader(); };
  $$('#readingPage p').forEach(p=>p.onclick=async e=>{
    stopAllSpeech();
    const text=p.textContent||''; const wr=wordRangeAt(text,caretOffsetInParagraph(p,e));
    state.selectedCharOffset=wr.start; state.selectedWordEnd=wr.end;
    await selectParagraph(+p.dataset.p,false,true);
    markStartWord(+p.dataset.p,wr.start,wr.end);
    const label=$('#positionLabel'); if(label) label.textContent=`Paragraph ${+p.dataset.p+1} · starts “${wr.word}”`;
  });
  $('#positionRange').oninput=e=>{state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(+e.target.value,true);};
  $('#playBtn').onclick=toggleSpeech;
  $('#prevBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.max(0,state.selectedParagraph-1)); };
  $('#nextBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.min(ch.paragraphs.length-1,state.selectedParagraph+1)); };
  $('#testVoiceBtn').onclick=testVoice;
  $('#rateRange').oninput=e=>{const r=+e.target.value; savePrefs({rate:r}); $('#speedLabel').textContent=r+'×'; updateVoiceSummary(); if(state.isSpeaking) startSpeech(true);};
  const voiceSelect=$('#voiceSelect'); if(voiceSelect) voiceSelect.onchange=e=>{savePrefs({voiceName:e.target.value});updateVoiceSummary();};
}
async function selectParagraph(i,noScroll=false,preserveWord=false){ state.selectedParagraph=i; if(!preserveWord){state.selectedCharOffset=0;state.selectedWordEnd=0;} $$('#readingPage p').forEach(p=>p.classList.toggle('selected',+p.dataset.p===i)); $('#positionRange').value=i; $('#positionLabel').textContent=`Paragraph ${i+1} of ${$('#readingPage').children.length}`; const book=await idbGet('books',state.bookId); await saveProgress(book); if(!noScroll) scrollSelected(); }
function scrollSelected(smooth=true){ const el=$(`#readingPage p[data-p="${state.selectedParagraph}"]`); if(el) el.scrollIntoView({block:'center',behavior:smooth?'smooth':'auto'}); }
async function saveProgress(book){ book.progress={chapterIndex:state.chapterIndex,paragraphIndex:state.selectedParagraph,charOffset:state.selectedCharOffset||0,wordEnd:state.selectedWordEnd||0}; book.updatedAt=new Date().toISOString(); await idbPut('books',book); savePrefs({lastBookId:book.id,lastChapterIndex:state.chapterIndex,lastParagraphIndex:state.selectedParagraph,lastCharOffset:state.selectedCharOffset||0,lastWordEnd:state.selectedWordEnd||0}); }
function updateVoiceSummary(){
  const sel=$('#voiceSelect'); const summary=$('#voiceSummary'); const st=$('#voiceStatus');
  const name=sel?.value||prefs().voiceName||'Device voice'; const rate=prefs().rate||1.05;
  if(summary)summary.textContent=`${name} · ${rate}×`;
  if(st&&!state.isSpeaking)st.textContent=`${name} ready`;
}
function loadVoices(){
  const fill=()=>{
    state.voices=speechSynthesis.getVoices(); const sel=$('#voiceSelect'); if(!sel)return;
    const wanted=prefs().voiceName || (state.voices.find(v=>v.name==='Samantha')?.name||'');
    sel.innerHTML=state.voices.map(v=>`<option value="${escapeHtml(v.name)}" ${v.name===wanted?'selected':''}>${escapeHtml(v.name)}${v.lang?' · '+escapeHtml(v.lang):''}</option>`).join('')||'<option>Default device voice</option>';
    if(wanted&&state.voices.some(v=>v.name===wanted))sel.value=wanted;
    updateVoiceSummary();
  };
  fill(); speechSynthesis.onvoiceschanged=fill;
}
function toggleSpeech(){
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  if(state.isSpeaking&&!state.isPaused){ speechSynthesis.pause(); state.isPaused=true; $('#playBtn').textContent='▶'; return; }
  if(state.isSpeaking&&state.isPaused){ speechSynthesis.resume(); state.isPaused=false; $('#playBtn').textContent='Ⅱ'; return; }
  startSpeech(true);
}
function startSpeech(fromSelected=true){
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  const paras=$$('#readingPage p').map(p=>(p.textContent||'').trim());
  if(!paras.some(Boolean)){ showToast('There is no text to read in this chapter.'); return; }

  let pIndex=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  pIndex=Math.max(0,Math.min(pIndex,paras.length-1));
  let firstOffset=fromSelected?(state.selectedCharOffset||0):0;
  const p=prefs();
  const selectedVoice=p.voiceName||$('#voiceSelect')?.value;
  const v=state.voices.find(x=>x.name===selectedVoice) || state.voices.find(x=>x.name==='Samantha') || state.voices[0];

  const begin=()=>{
    state.isSpeaking=true; state.isPaused=false;
    const st=$('#voiceStatus'); if(st)st.textContent='Starting…';
    const play=$('#playBtn'); if(play){play.textContent='Ⅱ';play.setAttribute('aria-label','Pause');}

    let firstAudible=true;
    const speakParagraph=()=>{
      if(!state.isSpeaking||pIndex>=paras.length){finishSpeech();return}
      const full=paras[pIndex]; const start=(pIndex===state.selectedParagraph?firstOffset:0);
      const segments=sentenceSegments(full,start);
      let sIndex=0;
      state.speakingParagraph=pIndex; state.selectedParagraph=pIndex; markSpeaking(pIndex);
      const range=$('#positionRange'); if(range)range.value=pIndex;
      const label=$('#positionLabel'); if(label)label.textContent=`Paragraph ${pIndex+1} of ${paras.length}`;

      const speakSentence=()=>{
        if(!state.isSpeaking)return;
        if(sIndex>=segments.length){
          const currentP=$(`#readingPage p[data-p="${pIndex}"]`); if(currentP)currentP.textContent=full;
          state.selectedCharOffset=0; state.selectedWordEnd=0;
          idbGet('books',state.bookId).then(book=>book&&saveProgress(book)).catch(()=>{});
          pIndex++; firstOffset=0; speakParagraph(); return;
        }
        const seg=segments[sIndex];
        highlightRange(pIndex,seg.start,seg.end);
        if(st)st.textContent=`Reading paragraph ${pIndex+1} · sentence ${sIndex+1}/${segments.length}`;
        const spokenText=firstAudible?`… ${seg.text}`:seg.text; firstAudible=false;
        const u=new SpeechSynthesisUtterance(spokenText);
        state.activeUtterance=u;
        u.rate=+(p.rate||1.05); u.volume=1; u.pitch=1;
        if(v){u.voice=v;u.lang=v.lang;}else{u.lang=navigator.language||'en-US';}
        u.onend=()=>{if(!state.isSpeaking)return;state.activeUtterance=null;sIndex++;speakSentence();};
        u.onerror=e=>{state.activeUtterance=null;if(e.error!=='canceled'&&e.error!=='interrupted')showToast('The device voice could not continue.');finishSpeech();};
        speechSynthesis.speak(u);
      };
      speakSentence();
    };

    setTimeout(speakParagraph,80);
  };

  if(speechSynthesis.speaking||speechSynthesis.pending){
    speechSynthesis.cancel(); setTimeout(()=>{speechSynthesis.resume();begin();},80);
  }else{speechSynthesis.resume();begin();}
}
function stopAllSpeech(){
  try{ speechSynthesis.cancel(); }catch{}
  try{ if(window.meSpeak) meSpeak.stop(); }catch{}
  state.isSpeaking=false; state.isPaused=false; state.activeUtterance=null; state.localSpeakingId=null; state.speakingParagraph=null;
  const b=$('#playBtn'); if(b){b.textContent='▶';b.setAttribute('aria-label','Play');}
  const st=$('#voiceStatus'); if(st) st.textContent='Device voice ready';
  $$('#readingPage p').forEach(p=>p.classList.remove('speaking')); clearSentenceHighlights();
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
  const st=$('#voiceStatus'); if(st)st.textContent='Loading free local voice…';
  const play=$('#playBtn'); if(play)play.textContent='…';
  try{await ensureLocalTTS();}catch(e){if(st)st.textContent='Local voice failed to load';if(play)play.textContent='▶';showToast(e.message);return}
  try{meSpeak.stop();}catch{}
  state.isSpeaking=true; state.isPaused=false;
  if(play){play.textContent='■';play.setAttribute('aria-label','Stop');}

  const speakParagraph=()=>{
    if(!state.isSpeaking||pIndex>=paras.length){finishSpeech();return}
    const sentences=splitSentences(paras[pIndex]);
    let sIndex=0;
    state.speakingParagraph=pIndex; state.selectedParagraph=pIndex; markSpeaking(pIndex);
    const range=$('#positionRange'); if(range)range.value=pIndex;
    const label=$('#positionLabel'); if(label)label.textContent=`Paragraph ${pIndex+1} of ${paras.length}`;

    const speakSentence=()=>{
      if(!state.isSpeaking)return;
      if(sIndex>=sentences.length){
        const currentP=$(`#readingPage p[data-p="${pIndex}"]`); if(currentP) currentP.textContent=paras[pIndex];
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
  speechSynthesis.cancel();
  const selectedVoice=prefs().voiceName||$('#voiceSelect')?.value;
  const v=state.voices.find(x=>x.name===selectedVoice) || state.voices.find(x=>x.lang==='en-US') || state.voices[0];
  const u=new SpeechSynthesisUtterance('Storyline Studio voice test.');
  state.activeUtterance=u;
  u.volume=1; u.rate=1; u.pitch=1;
  if(v){ u.voice=v; u.lang=v.lang; } else { u.lang='en-US'; }
  const st=$('#voiceStatus');
  if(st) st.textContent='Testing…';
  u.onstart=()=>{ if(st) st.textContent='Test is speaking'; showToast('Voice test started'); };
  u.onend=()=>{ state.activeUtterance=null; if(st) st.textContent='Test finished'; showToast('Voice test finished'); };
  u.onerror=e=>{ state.activeUtterance=null; if(st) st.textContent='Voice error: '+(e.error||'unknown'); showToast('Voice error: '+(e.error||'unknown')); };
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
function finishSpeech(){ state.isSpeaking=false; state.isPaused=false; state.speakingParagraph=null; state.activeUtterance=null; state.localSpeakingId=null; const b=$('#playBtn'); if(b){b.textContent='▶';b.setAttribute('aria-label','Play');} $$('#readingPage p').forEach(p=>p.classList.remove('speaking')); clearSentenceHighlights(); const st=$('#voiceStatus'); if(st)st.textContent='Device voice ready'; }

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
async function handleAction(act,book,ch){ const text=ch.paragraphs[state.selectedParagraph]||''; const base={bookId:book.id,bookTitle:book.title,chapterIndex:state.chapterIndex,chapterTitle:ch.title,paragraphIndex:state.selectedParagraph,charOffset:state.selectedCharOffset||0,wordEnd:state.selectedWordEnd||0,excerpt:excerpt(text),createdAt:new Date().toISOString(),status:'open'};
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
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){
    showToast('Audio recording is not available in this browser.');
    return;
  }
  let stream=null,recorder=null,chunks=[],audioBlob=null,previewUrl=null,recording=false,recordStartedAt=0,audioDurationSec=0;
  modalForm.innerHTML=`<h3>Voice note</h3>
    <div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1}</div>
    <div class="excerpt">${escapeHtml(base.excerpt)}</div>
    <div id="voiceRecordStatus" class="sub">Record an audio note. It stays in this browser.</div>
    <audio id="voicePreview" class="voice-preview hidden" controls></audio>
    <textarea id="voiceCaption" placeholder="Optional caption or typed note"></textarea>
    <div class="row between">
      <button value="cancel" class="button secondary">Cancel</button>
      <div class="row">
        <button type="button" id="dictateCaption" class="ghost">🎙 Dictate caption</button>
        <button type="button" id="recordAudioBtn" class="ghost">● Record</button>
        <button type="button" id="saveAudioNote" class="button">Save voice note</button>
      </div>
    </div>`;
  modal.showModal();
  attachDictation($('#dictateCaption'),$('#voiceCaption'));

  const cleanup=()=>{
    try{if(recorder&&recording)recorder.stop()}catch{}
    try{stream?.getTracks().forEach(t=>t.stop())}catch{}
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null}
  };
  modal.onclose=cleanup;

  $('#recordAudioBtn').onclick=async()=>{
    if(recording){try{recorder.stop()}catch{};return}
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      chunks=[]; audioBlob=null;
      const mime=chooseAudioMime();
      recorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
      recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
      recorder.onstart=()=>{recording=true;recordStartedAt=Date.now();$('#recordAudioBtn').textContent='■ Stop';$('#voiceRecordStatus').textContent='Recording…'};
      recorder.onstop=()=>{
        recording=false;
        audioDurationSec=recordStartedAt?Math.max(1,Math.round((Date.now()-recordStartedAt)/1000)):0;
        $('#recordAudioBtn').textContent='● Record again';
        const type=recorder.mimeType||mime||'audio/mp4';
        audioBlob=new Blob(chunks,{type});
        try{stream?.getTracks().forEach(t=>t.stop())}catch{}
        if(previewUrl)URL.revokeObjectURL(previewUrl);
        previewUrl=URL.createObjectURL(audioBlob);
        const a=$('#voicePreview'); a.src=previewUrl;a.classList.remove('hidden');
        $('#voiceRecordStatus').textContent=`Recorded · ${formatDuration(audioDurationSec)}. Play it back before saving if you want.`;
      };
      recorder.onerror=()=>{recording=false;$('#voiceRecordStatus').textContent='Recording failed. Please try again.'};
      recorder.start();
    }catch(e){
      $('#voiceRecordStatus').textContent='Microphone access was not available.';
      showToast('Microphone access is needed for a voice note.');
    }
  };

  $('#saveAudioNote').onclick=async()=>{
    if(recording){showToast('Stop the recording before saving.');return}
    if(!audioBlob){showToast('Record something first.');return}
    const note=$('#voiceCaption').value.trim();
    await idbPut('items',{...base,id:uid(),type:'voice',note,voice:true,audioBlob,audioType:audioBlob.type,durationSec:audioDurationSec});
    modal.onclose=null; cleanup(); modal.close(); showToast('Voice note saved'); updateQueueBadge();
  };
}

async function renderNotes(){ const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b])); const items=(await idbGetAll('items')).filter(i=>['note','bookmark','voice'].includes(i.type)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  view.innerHTML=`<section class="hero"><div class="eyebrow">Listening memory</div><h1>Notes & bookmarks</h1><p class="sub">Everything you caught while listening, still attached to where you heard it.</p></section>${items.length?`<div class="list">${items.map(i=>itemHtml(i,bookMap)).join('')}</div>`:`<div class="empty card">No notes yet. This is suspiciously peaceful.</div>`}`; wireItemButtons(); }
async function renderQueue(){ const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b])); const items=(await idbGetAll('items')).filter(i=>['question','continuity','note','bookmark','voice'].includes(i.type)).sort((a,b)=>(a.status==='done')-(b.status==='done')||new Date(b.createdAt)-new Date(a.createdAt)); const open=items.filter(i=>i.status!=='done').length;
  view.innerHTML=`<section class="hero"><div class="eyebrow">Revision desk</div><h1>Revision Queue</h1><p class="sub">Questions stay questions until you decide what to change.</p></section><div class="stat-grid"><div class="stat"><b>${open}</b><small>Open</small></div><div class="stat"><b>${items.filter(i=>i.type==='continuity').length}</b><small>Continuity</small></div><div class="stat"><b>${items.filter(i=>['note','voice'].includes(i.type)).length}</b><small>Notes</small></div></div>${items.length?`<div class="list" style="margin-top:16px">${items.map(i=>itemHtml(i,bookMap,true)).join('')}</div>`:`<div class="empty card" style="margin-top:16px">Nothing waiting for review.</div>`}`; wireItemButtons(); }
function itemHtml(i,bookMap,queue=false){
  const label=i.type==='question'?'Ask ChatGPT':i.type==='continuity'?'Continuity':i.type==='bookmark'?'Bookmark':i.type==='voice'?'Voice note':'Note';
  const pill=i.status==='done'?'green':i.type==='question'||i.type==='continuity'?'gold':'';
  return `<article class="list-item" data-item="${i.id}">
    <div class="row between"><span class="pill ${pill}">${label}</span><span class="meta item-time">${formatItemTime(i.createdAt)}${i.durationSec?` · ${formatDuration(i.durationSec)}`:''}</span></div>
    <div><strong>${escapeHtml(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript')}</strong><div class="source-chip">${escapeHtml(i.chapterTitle||'Chapter')} · paragraph ${(i.paragraphIndex??0)+1}</div></div>
    <div class="excerpt">${escapeHtml(i.excerpt||'')}</div>
    ${i.note?`<div class="note-text">${escapeHtml(i.note)}</div>`:''}
    ${i.audioBlob?`<audio class="saved-voice-note" controls data-audio-item="${i.id}"></audio>`:''}
    <div class="row">
      <button data-open-item="${i.id}" class="ghost tiny">Open passage</button>
      ${queue?`<button data-copy="${i.id}" class="ghost tiny">Copy for ChatGPT</button><button data-done="${i.id}" class="ghost tiny">${i.status==='done'?'Reopen':'Mark done'}</button>`:''}
      <button data-delete-item="${i.id}" class="ghost tiny">Delete</button>
    </div>
  </article>`;
}
function wireItemButtons(){
  $$('[data-audio-item]').forEach(async a=>{
    const i=await idbGet('items',a.dataset.audioItem);
    if(i?.audioBlob){const u=URL.createObjectURL(i.audioBlob);a.src=u;a.dataset.objectUrl=u;}
  });
  $$('[data-open-item]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.openItem);
    if(!i)return;
    const book=await idbGet('books',i.bookId);
    if(!book){showToast('That manuscript is no longer in this browser.');return}
    state.bookId=i.bookId;
    state.chapterIndex=i.chapterIndex??0;
    state.selectedParagraph=i.paragraphIndex??0;
    state.selectedCharOffset=i.charOffset??0; state.selectedWordEnd=i.wordEnd??0;
    savePrefs({lastBookId:state.bookId});
    await saveProgress(book);
    navigate('reader');
  });
  $$('[data-delete-item]').forEach(b=>b.onclick=async()=>{await idbDelete('items',b.dataset.deleteItem);navigate(state.route)});
  $$('[data-done]').forEach(b=>b.onclick=async()=>{const i=await idbGet('items',b.dataset.done);i.status=i.status==='done'?'open':'done';await idbPut('items',i);navigate('queue')});
  $$('[data-copy]').forEach(b=>b.onclick=async()=>{const i=await idbGet('items',b.dataset.copy); const packet=`Storyline Studio revision question\n\nBook: ${i.bookTitle}\nLocation: ${i.chapterTitle}, paragraph ${(i.paragraphIndex||0)+1}\nType: ${i.type}\n\nPassage:\n${i.excerpt}\n\nMy note/question:\n${i.note}\n\nPlease answer using the manuscript context I provide, and do not revise the manuscript unless I explicitly ask.`; try{await navigator.clipboard.writeText(packet);showToast('Copied for ChatGPT')}catch{showToast('Copy was blocked by the browser')}});
}

$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
$$('[data-reader-act]').forEach(b=>b.addEventListener('click',async()=>{
  if(state.route!=='reader'||!state.bookId)return;
  const book=await idbGet('books',state.bookId); if(!book)return;
  const ch=book.chapters[state.chapterIndex]; if(!ch)return;
  document.body.classList.remove('mobile-tools-open');
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
window.addEventListener('pagehide',()=>stopAllSpeech());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

openDB().then(async()=>{ let p=prefs(); if(p.engine!=='device'){ savePrefs({engine:'device'}); p=prefs(); } state.bookId=p.lastBookId||null; if(state.bookId){ const b=await idbGet('books',state.bookId); if(b){ state.chapterIndex=b.progress?.chapterIndex ?? p.lastChapterIndex ?? 0; state.selectedParagraph=b.progress?.paragraphIndex ?? p.lastParagraphIndex ?? 0; state.selectedCharOffset=b.progress?.charOffset ?? p.lastCharOffset ?? 0; state.selectedWordEnd=b.progress?.wordEnd ?? p.lastWordEnd ?? 0; } } await navigate('library'); }).catch(e=>{view.innerHTML=`<div class="empty">Storyline could not start: ${escapeHtml(e.message)}</div>`});
})();