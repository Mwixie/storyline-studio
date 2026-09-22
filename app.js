(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const view = $('#view'), fileInput = $('#fileInput'), modal = $('#modal'), modalForm = $('#modalForm'), toast = $('#toast');

const state = {
  route:'library', bookId:null, chapterIndex:0, selectedParagraph:0, speakingParagraph:null,
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
function currentEngine(){ const p=prefs(); return p.engine || (isIOS() ? 'local' : 'device'); }
function localVoiceVariant(){ const v=prefs().localVariant||'f2'; return ['f2','f3','m3'].includes(v)?v:'f2'; }
function excerpt(s,n=180){ const x=(s||'').trim(); return x.length>n?x.slice(0,n-1)+'…':x; }
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

async function updateQueueBadge(){ const items=await idbGetAll('items'); const open=items.filter(i=>['question','continuity'].includes(i.type)&&i.status!=='done').length; const b=$('#queueBadge'); b.textContent=open; b.classList.toggle('hidden',!open); }
function setNav(route){ $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.nav===route)); }
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
  $$('.book-card').forEach(c=>c.onclick=async e=>{ if(e.target.closest('[data-delete]')) return; state.bookId=c.dataset.id; savePrefs({lastBookId:state.bookId}); const b=await idbGet('books',state.bookId); state.chapterIndex=b.progress?.chapterIndex||0; state.selectedParagraph=b.progress?.paragraphIndex||0; navigate('reader'); });
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
    <section class="player">
      <div class="player-main">
        <div class="transport-buttons">
          <button id="prevBtn" class="ghost transport-skip" aria-label="Previous paragraph">‹</button>
          <button id="playBtn" class="button play" aria-label="Play">▶</button>
          <button id="nextBtn" class="ghost transport-skip" aria-label="Next paragraph">›</button>
        </div>
        <div class="transport-progress"><div class="row between"><span id="positionLabel" class="meta">Paragraph ${state.selectedParagraph+1} of ${ch.paragraphs.length}</span><span id="speedLabel" class="meta">${p.rate||1.05}×</span></div><input id="positionRange" class="range" type="range" min="0" max="${Math.max(ch.paragraphs.length-1,0)}" value="${state.selectedParagraph}" /></div>
        <button id="startBtn" class="ghost tiny">Start here</button>
      </div>
      <div class="player-settings polished-settings">
        <select id="engineSelect" class="select">
          <option value="device" ${currentEngine()==='device'?'selected':''}>Device voice</option>
          <option value="local" ${currentEngine()==='local'?'selected':''}>Free local voice</option>
        </select>
        ${currentEngine()==='local'
          ? `<select id="localVoiceSelect" class="select">
              <option value="f2" ${localVoiceVariant()==='f2'?'selected':''}>Female 2 · softer</option>
              <option value="f3" ${localVoiceVariant()==='f3'?'selected':''}>Female 3 · brighter</option>
              <option value="m3" ${localVoiceVariant()==='m3'?'selected':''}>Male 3 · lower</option>
            </select>`
          : `<select id="voiceSelect" class="select"><option>Loading voices…</option></select>`}
        <div class="speed-box"><span class="meta">Speed</span><input id="rateRange" class="range" type="range" min="0.75" max="1.75" step="0.05" value="${p.rate||1.05}" title="Reading speed" /></div>
      </div>
      <div class="reader-status-row">
        <span id="voiceStatus" class="reading-status">${currentEngine()==='local'?'Free local voice ready':'Device voice ready'}</span>
        <div class="diagnostic-actions"><button id="testVoiceBtn" class="ghost tiny">Test voice</button><button id="testSoundBtn" class="ghost tiny">Audio check</button></div>
      </div>
      <div class="quick-actions">
        <button class="action" data-act="note"><b>✎</b>Add note</button><button class="action" data-act="voice"><b>●</b>Voice note</button><button class="action" data-act="ask"><b>✦</b>Ask ChatGPT</button><button class="action" data-act="continuity"><b>⚑</b>Flag continuity</button><button class="action" data-act="bookmark"><b>⌑</b>Bookmark</button><button class="action primary" data-act="start"><b>▶</b>Start from here</button><button class="action" data-act="queue"><b>☷</b>Revision queue</button>
      </div>
    </section>`;
  wireReader(book,ch); loadVoices(); requestAnimationFrame(()=>scrollSelected(false));
}

function wireReader(book,ch){
  $('#backLibrary').onclick=()=>navigate('library');
  $('#chapterSelect').onchange=async e=>{ state.chapterIndex=+e.target.value; state.selectedParagraph=0; await saveProgress(book); renderReader(); };
  $$('#readingPage p').forEach(p=>p.onclick=()=>selectParagraph(+p.dataset.p));
  $('#positionRange').oninput=e=>selectParagraph(+e.target.value,true);
  $('#playBtn').onclick=toggleSpeech;
  $('#startBtn').onclick=()=>startSpeech(true);
  $('#prevBtn').onclick=()=>{ stopAllSpeech(); selectParagraph(Math.max(0,state.selectedParagraph-1)); };
  $('#nextBtn').onclick=()=>{ stopAllSpeech(); selectParagraph(Math.min(ch.paragraphs.length-1,state.selectedParagraph+1)); };
  $('#testVoiceBtn').onclick=testSelectedVoice;
  $('#testSoundBtn').onclick=testSound;
  $('#engineSelect').onchange=e=>{ savePrefs({engine:e.target.value}); stopAllSpeech(); renderReader(); };
  $('#rateRange').oninput=e=>{const r=+e.target.value; savePrefs({rate:r}); $('#speedLabel').textContent=r+'×'; if(state.isSpeaking){ if(currentEngine()==='local') startLocalSpeech(true); else startSpeech(true); }};
  const voiceSelect=$('#voiceSelect'); if(voiceSelect) voiceSelect.onchange=e=>savePrefs({voiceName:e.target.value});
  const localVoiceSelect=$('#localVoiceSelect'); if(localVoiceSelect) localVoiceSelect.onchange=e=>{ savePrefs({localVariant:e.target.value}); if(state.isSpeaking) startLocalSpeech(true); };
  $$('.action').forEach(b=>b.onclick=()=>handleAction(b.dataset.act,book,ch));
}
async function selectParagraph(i,noScroll=false){ state.selectedParagraph=i; $$('#readingPage p').forEach(p=>p.classList.toggle('selected',+p.dataset.p===i)); $('#positionRange').value=i; $('#positionLabel').textContent=`Paragraph ${i+1} of ${$('#readingPage').children.length}`; const book=await idbGet('books',state.bookId); await saveProgress(book); if(!noScroll) scrollSelected(); }
function scrollSelected(smooth=true){ const el=$(`#readingPage p[data-p="${state.selectedParagraph}"]`); if(el) el.scrollIntoView({block:'center',behavior:smooth?'smooth':'auto'}); }
async function saveProgress(book){ book.progress={chapterIndex:state.chapterIndex,paragraphIndex:state.selectedParagraph}; book.updatedAt=new Date().toISOString(); await idbPut('books',book); savePrefs({lastBookId:book.id,lastChapterIndex:state.chapterIndex,lastParagraphIndex:state.selectedParagraph}); }
function loadVoices(){
  const fill=()=>{ state.voices=speechSynthesis.getVoices(); const sel=$('#voiceSelect'); if(!sel) return; const wanted=prefs().voiceName; sel.innerHTML=state.voices.map(v=>`<option value="${escapeHtml(v.name)}" ${v.name===wanted?'selected':''}>${escapeHtml(v.name)}${v.lang?' · '+escapeHtml(v.lang):''}</option>`).join('')||'<option>Default device voice</option>'; };
  fill(); speechSynthesis.onvoiceschanged=fill;
}
function toggleSpeech(){
  const engine=currentEngine();
  if(engine==='local'){
    if(state.isSpeaking){ stopAllSpeech(); return; }
    startLocalSpeech(true); return;
  }
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  if(state.isSpeaking&&!state.isPaused){ speechSynthesis.pause(); state.isPaused=true; $('#playBtn').textContent='▶'; return; }
  if(state.isSpeaking&&state.isPaused){ speechSynthesis.resume(); state.isPaused=false; $('#playBtn').textContent='Ⅱ'; return; }
  startSpeech(true);
}
function startSpeech(fromSelected=true){
  if(currentEngine()==='local'){ startLocalSpeech(fromSelected); return; }
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  const texts=$$('#readingPage p').map(p=>(p.textContent||'').trim()).filter(Boolean);
  if(!texts.length){ showToast('There is no text to read in this chapter.'); return; }

  let index=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  index=Math.max(0,Math.min(index,texts.length-1));

  const begin=()=>{
    state.isSpeaking=true; state.isPaused=false;
    const st=$('#voiceStatus'); if(st) st.textContent='Starting…';

    const speakNext=()=>{
      if(!state.isSpeaking || index>=texts.length){ finishSpeech(); return; }
      state.speakingParagraph=index; state.selectedParagraph=index; markSpeaking(index);
      const range=$('#positionRange'); if(range) range.value=index;
      const label=$('#positionLabel'); if(label) label.textContent=`Paragraph ${index+1} of ${texts.length}`;

      const u=new SpeechSynthesisUtterance(texts[index]);
      state.activeUtterance=u;
      const p=prefs();
      u.rate=+(p.rate||1.05);
      u.volume=1;
      u.pitch=1;
      const selectedVoice=p.voiceName||$('#voiceSelect')?.value;
      const v=state.voices.find(x=>x.name===selectedVoice);
      if(v){ u.voice=v; u.lang=v.lang; } else { u.lang=navigator.language||'en-US'; }

      u.onstart=()=>{ state.isSpeaking=true; state.isPaused=false; const play=$('#playBtn'); if(play) play.textContent='Ⅱ'; const st=$('#voiceStatus'); if(st) st.textContent='Speaking'; };
      u.onend=()=>{ if(!state.isSpeaking) return; state.activeUtterance=null; index++; speakNext(); };
      u.onerror=e=>{
        state.activeUtterance=null;
        if(e.error!=='canceled' && e.error!=='interrupted') showToast('The device voice could not start. Try another voice.');
        finishSpeech();
      };

      speechSynthesis.speak(u);
      idbGet('books',state.bookId).then(book=>book&&saveProgress(book)).catch(()=>{});
    };
    speakNext();
  };

  if(speechSynthesis.speaking || speechSynthesis.pending){
    speechSynthesis.cancel();
    setTimeout(()=>{ speechSynthesis.resume(); begin(); },60);
  }else{
    speechSynthesis.resume();
    begin();
  }
}
function stopAllSpeech(){
  try{ speechSynthesis.cancel(); }catch{}
  try{ if(window.meSpeak) meSpeak.stop(); }catch{}
  state.isSpeaking=false; state.isPaused=false; state.activeUtterance=null; state.localSpeakingId=null; state.speakingParagraph=null;
  const b=$('#playBtn'); if(b){b.textContent='▶';b.setAttribute('aria-label','Play');}
  const st=$('#voiceStatus'); if(st) st.textContent=currentEngine()==='local'?'Free local voice ready':'Device voice ready';
  $('#readingPage p').forEach(p=>p.classList.remove('speaking')); clearSentenceHighlights();
}
function ensureLocalTTS(){
  if(state.localTTSReady && window.meSpeak) return Promise.resolve();
  if(window.__storylineLocalTTSLoading) return window.__storylineLocalTTSLoading;
  const base='https://cdn.jsdelivr.net/gh/btopro/mespeak@master/';
  window.__storylineLocalTTSLoading=new Promise((resolve,reject)=>{
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
  }).catch(e=>{ window.__storylineLocalTTSLoading=null; throw e; });
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
  if(currentEngine()==='local'){ testLocalVoice(); } else { testVoice(); }
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
function finishSpeech(){ state.isSpeaking=false; state.isPaused=false; state.speakingParagraph=null; state.activeUtterance=null; state.localSpeakingId=null; const b=$('#playBtn'); if(b){b.textContent='▶';b.setAttribute('aria-label','Play');} $$('#readingPage p').forEach(p=>p.classList.remove('speaking')); clearSentenceHighlights(); const st=$('#voiceStatus'); if(st)st.textContent=currentEngine()==='local'?'Free local voice ready':'Device voice ready'; }

async function handleAction(act,book,ch){ const text=ch.paragraphs[state.selectedParagraph]||''; const base={bookId:book.id,bookTitle:book.title,chapterIndex:state.chapterIndex,chapterTitle:ch.title,paragraphIndex:state.selectedParagraph,excerpt:excerpt(text),createdAt:new Date().toISOString(),status:'open'};
  if(act==='start'){ if(currentEngine()==='local') startLocalSpeech(true); else startSpeech(true); return} if(act==='queue'){navigate('queue');return}
  if(act==='bookmark'){await idbPut('items',{...base,id:uid(),type:'bookmark',note:''});showToast('Bookmarked');updateQueueBadge();return}
  if(act==='note') return promptItem('note','Add note','What did you notice?',base);
  if(act==='continuity') return promptItem('continuity','Flag continuity','What seems inconsistent or needs checking?',base);
  if(act==='ask') return promptItem('question','Ask ChatGPT later','What do you want me to check, explain, or revise?',base);
  if(act==='voice') return voiceNote(base);
}
function promptItem(type,title,placeholder,base){
  modalForm.innerHTML=`<h3>${title}</h3><div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1}</div><div class="excerpt">${escapeHtml(base.excerpt)}</div><textarea id="itemText" placeholder="${escapeHtml(placeholder)}" autofocus></textarea><div class="row between"><button value="cancel" class="button secondary">Cancel</button><button id="saveItem" value="default" class="button">Save</button></div>`;
  modal.showModal(); setTimeout(()=>$('#itemText')?.focus(),50); $('#saveItem').onclick=async e=>{e.preventDefault();const note=$('#itemText').value.trim(); if(!note){showToast('Add a note first');return} await idbPut('items',{...base,id:uid(),type,note}); modal.close(); showToast(type==='question'?'Added to revision queue':'Saved'); updateQueueBadge();};
}
function voiceNote(base){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){ promptItem('note','Voice note unavailable','Speech recognition is not available in this browser. Type the note instead.',base); return; }
  modalForm.innerHTML=`<h3>Voice note</h3><div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1}</div><div id="listening" class="sub">Tap start, then say what you noticed.</div><textarea id="voiceText" placeholder="Your transcription will appear here"></textarea><div class="row between"><button value="cancel" class="button secondary">Cancel</button><button type="button" id="recordBtn" class="ghost">● Start recording</button><button type="button" id="saveVoice" class="button">Save note</button></div>`; modal.showModal(); const r=new SR(); r.continuous=true;r.interimResults=true;r.lang='en-US'; let final=''; r.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)final+=t+' ';else interim+=t;}$('#voiceText').value=(final+interim).trim();};r.onstart=()=>{$('#listening').textContent='Listening…';$('#recordBtn').textContent='■ Stop recording'};r.onend=()=>{$('#listening').textContent='Recording stopped.';$('#recordBtn').textContent='● Start recording'};$('#recordBtn').onclick=()=>{try{if($('#recordBtn').textContent.includes('Stop'))r.stop();else r.start();}catch{}};$('#saveVoice').onclick=async()=>{try{r.stop()}catch{}const note=$('#voiceText').value.trim();if(!note){showToast('Nothing recorded yet');return}await idbPut('items',{...base,id:uid(),type:'note',note,voice:true});modal.close();showToast('Voice note saved');};
}

async function renderNotes(){ const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b])); const items=(await idbGetAll('items')).filter(i=>['note','bookmark'].includes(i.type)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  view.innerHTML=`<section class="hero"><div class="eyebrow">Listening memory</div><h1>Notes & bookmarks</h1><p class="sub">Everything you caught while listening, still attached to where you heard it.</p></section>${items.length?`<div class="list">${items.map(i=>itemHtml(i,bookMap)).join('')}</div>`:`<div class="empty card">No notes yet. This is suspiciously peaceful.</div>`}`; wireItemButtons(); }
async function renderQueue(){ const books=await idbGetAll('books'); const bookMap=Object.fromEntries(books.map(b=>[b.id,b])); const items=(await idbGetAll('items')).filter(i=>['question','continuity'].includes(i.type)).sort((a,b)=>(a.status==='done')-(b.status==='done')||new Date(b.createdAt)-new Date(a.createdAt)); const open=items.filter(i=>i.status!=='done').length;
  view.innerHTML=`<section class="hero"><div class="eyebrow">Revision desk</div><h1>Revision Queue</h1><p class="sub">Questions stay questions until you decide what to change.</p></section><div class="stat-grid"><div class="stat"><b>${open}</b><small>Open</small></div><div class="stat"><b>${items.filter(i=>i.type==='continuity').length}</b><small>Continuity</small></div><div class="stat"><b>${items.filter(i=>i.type==='question').length}</b><small>Ask AI</small></div></div>${items.length?`<div class="list" style="margin-top:16px">${items.map(i=>itemHtml(i,bookMap,true)).join('')}</div>`:`<div class="empty card" style="margin-top:16px">Nothing waiting for review.</div>`}`; wireItemButtons(); }
function itemHtml(i,bookMap,queue=false){
  const label=i.type==='question'?'Ask ChatGPT':i.type==='continuity'?'Continuity':i.type==='bookmark'?'Bookmark':'Note';
  const pill=i.status==='done'?'green':i.type==='question'||i.type==='continuity'?'gold':'';
  return `<article class="list-item" data-item="${i.id}">
    <div class="row between"><span class="pill ${pill}">${label}${i.voice?' · voice':''}</span><span class="meta">${i.status==='done'?'Done':'Open'}</span></div>
    <div><strong>${escapeHtml(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript')}</strong><div class="source-chip">${escapeHtml(i.chapterTitle||'Chapter')} · paragraph ${(i.paragraphIndex??0)+1}</div></div>
    <div class="excerpt">${escapeHtml(i.excerpt||'')}</div>
    ${i.note?`<div class="note-text">${escapeHtml(i.note)}</div>`:''}
    <div class="row">
      <button data-open-item="${i.id}" class="ghost tiny">Open passage</button>
      ${queue?`<button data-copy="${i.id}" class="ghost tiny">Copy for ChatGPT</button><button data-done="${i.id}" class="ghost tiny">${i.status==='done'?'Reopen':'Mark done'}</button>`:''}
      <button data-delete-item="${i.id}" class="ghost tiny">Delete</button>
    </div>
  </article>`;
}
function wireItemButtons(){
  $$('[data-open-item]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.openItem);
    if(!i)return;
    const book=await idbGet('books',i.bookId);
    if(!book){showToast('That manuscript is no longer in this browser.');return}
    state.bookId=i.bookId;
    state.chapterIndex=i.chapterIndex??0;
    state.selectedParagraph=i.paragraphIndex??0;
    savePrefs({lastBookId:state.bookId});
    await saveProgress(book);
    navigate('reader');
  });
  $$('[data-delete-item]').forEach(b=>b.onclick=async()=>{await idbDelete('items',b.dataset.deleteItem);navigate(state.route)});
  $$('[data-done]').forEach(b=>b.onclick=async()=>{const i=await idbGet('items',b.dataset.done);i.status=i.status==='done'?'open':'done';await idbPut('items',i);navigate('queue')});
  $$('[data-copy]').forEach(b=>b.onclick=async()=>{const i=await idbGet('items',b.dataset.copy); const packet=`Storyline Studio revision question\n\nBook: ${i.bookTitle}\nLocation: ${i.chapterTitle}, paragraph ${(i.paragraphIndex||0)+1}\nType: ${i.type}\n\nPassage:\n${i.excerpt}\n\nMy note/question:\n${i.note}\n\nPlease answer using the manuscript context I provide, and do not revise the manuscript unless I explicitly ask.`; try{await navigator.clipboard.writeText(packet);showToast('Copied for ChatGPT')}catch{showToast('Copy was blocked by the browser')}});
}

$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
fileInput.addEventListener('change',e=>{importFile(e.target.files[0]);e.target.value=''});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredPrompt=e;$('#installBtn').classList.remove('hidden')});
$('#installBtn').onclick=async()=>{if(state.deferredPrompt){state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null;$('#installBtn').classList.add('hidden')}};
window.addEventListener('pagehide',()=>stopAllSpeech());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

openDB().then(async()=>{ const p=prefs(); state.bookId=p.lastBookId||null; if(state.bookId){ const b=await idbGet('books',state.bookId); if(b){ state.chapterIndex=b.progress?.chapterIndex ?? p.lastChapterIndex ?? 0; state.selectedParagraph=b.progress?.paragraphIndex ?? p.lastParagraphIndex ?? 0; } } await navigate('library'); }).catch(e=>{view.innerHTML=`<div class="empty">Storyline could not start: ${escapeHtml(e.message)}</div>`});
})();