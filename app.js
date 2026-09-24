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
  pendingPassageReference:null, activeEngine:'device', readerSearchQuery:'',
  followNarrationSuspended:false, readerBook:null, recapBookId:null, selectedReaderPhrase:'',
  liveCharOffset:null, pendingHandoffContext:null, handoffScanStop:null
};

const PREF='storyline.prefs.v1';
const dbName='storyline-studio';
let db;
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
function currentEngine(){ return state.activeEngine==='local'?'local':'device'; }
function localVoiceVariant(){ const v=prefs().localVariant||'f2'; return ['f2','f3','m3'].includes(v)?v:'f2'; }
function voiceKey(v){ return v?.voiceURI || `${v?.name||''}|${v?.lang||''}`; }
function isSamanthaVoice(v){return /^samantha(?:\b|\s|\()/i.test(String(v?.name||'').trim())}
function samanthaVoices(){return state.voices.filter(isSamanthaVoice)}
function voiceDisplayName(v){ return `${v?.name||'Samantha'}${v?.lang?' · '+v.lang:''} · ${v?.localService?'On device':'Online'}`; }
const READING_RATES=[0.75,0.80,0.85,0.90,0.95,1.00,1.05,1.10,1.15,1.20,1.25,1.30,1.35,1.40,1.45,1.50,1.55,1.60,1.65,1.70,1.75];
function rateOptions(selected){
  const wanted=Number(selected||1.05);
  return READING_RATES.map(r=>`<option value="${r.toFixed(2)}" ${Math.abs(r-wanted)<.001?'selected':''}>${r.toFixed(2)}×</option>`).join('');
}
const DIALOGUE_PITCHES=[0.70,0.80,0.90,1.00,1.05,1.10,1.15,1.20,1.25,1.30,1.35,1.40];
const DIALOGUE_RATE_OFFSETS=[-0.10,-0.05,0,0.05,0.10];
function dialoguePitchOptions(selected){
  const wanted=Number(selected??1.15);
  return DIALOGUE_PITCHES.map(v=>`<option value="${v.toFixed(2)}" ${Math.abs(v-wanted)<.001?'selected':''}>${v.toFixed(2)}× pitch</option>`).join('');
}
function dialogueRateOptions(selected){
  const wanted=Number(selected??0);
  return DIALOGUE_RATE_OFFSETS.map(v=>`<option value="${v.toFixed(2)}" ${Math.abs(v-wanted)<.001?'selected':''}>${v>0?'+':''}${v.toFixed(2)}× rate</option>`).join('');
}
function regexEscape(s=''){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function pronunciationRegex(entry){
  const raw=String(entry?.match||'').trim();
  if(!raw)return null;
  const escaped=regexEscape(raw);
  const simple=/^[A-Za-z0-9 ]+$/.test(raw);
  return new RegExp(simple?`\\b${escaped}\\b`:escaped,'gi');
}
function pronunciationMatches(source,entries=[]){
  const matches=[];
  const sorted=[...entries].filter(x=>x?.match&&x?.replacement).sort((a,b)=>b.match.length-a.match.length);
  for(const entry of sorted){
    const re=pronunciationRegex(entry);if(!re)continue;
    for(const m of source.matchAll(re))matches.push({start:m.index,end:m.index+m[0].length,replacement:String(entry.replacement),entry});
  }
  matches.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start));
  const chosen=[];let cursor=-1;
  for(const m of matches){if(m.start<cursor)continue;chosen.push(m);cursor=m.end}
  return chosen;
}
function transformSpeechText(source,entries=[],sourceBase=0){
  const text=String(source||''),matches=pronunciationMatches(text,entries);
  if(!matches.length)return {text,mapIndex:i=>sourceBase+Math.max(0,Math.min(Number(i)||0,text.length))};
  let spoken='',srcPos=0;
  const spans=[];
  for(const m of matches){
    if(m.start>srcPos){
      const part=text.slice(srcPos,m.start),spokenStart=spoken.length;
      spoken+=part;spans.push({spokenStart,spokenEnd:spoken.length,sourceStart:sourceBase+srcPos,sourceEnd:sourceBase+m.start,replace:false});
    }
    const spokenStart=spoken.length;
    spoken+=m.replacement;
    spans.push({spokenStart,spokenEnd:spoken.length,sourceStart:sourceBase+m.start,sourceEnd:sourceBase+m.end,replace:true});
    srcPos=m.end;
  }
  if(srcPos<text.length){
    const spokenStart=spoken.length;
    spoken+=text.slice(srcPos);spans.push({spokenStart,spokenEnd:spoken.length,sourceStart:sourceBase+srcPos,sourceEnd:sourceBase+text.length,replace:false});
  }
  const mapIndex=i=>{
    const pos=Math.max(0,Math.min(Number(i)||0,spoken.length));
    const span=spans.find(s=>pos>=s.spokenStart&&pos<=s.spokenEnd)||spans[spans.length-1];
    if(!span)return sourceBase;
    if(!span.replace)return Math.min(span.sourceEnd,span.sourceStart+(pos-span.spokenStart));
    const spokenLen=Math.max(1,span.spokenEnd-span.spokenStart),sourceLen=Math.max(1,span.sourceEnd-span.sourceStart);
    return Math.min(span.sourceEnd,span.sourceStart+Math.round(((pos-span.spokenStart)/spokenLen)*sourceLen));
  };
  return {text:spoken,mapIndex};
}
function dialogueRanges(source,start=0,end=source.length){
  const text=String(source||''),a=Math.max(0,start),b=Math.min(text.length,end);
  const ranges=[];let cursor=a,dialogueStart=null,quoteType=null;
  const push=(s,e,kind)=>{if(e>s)ranges.push({start:s,end:e,kind})};
  for(let i=a;i<b;i++){
    const ch=text[i],prev=text[i-1]||'',next=text[i+1]||'';
    let isQuote=false,type='';
    if(ch==='“'){isQuote=true;type='curly';if(dialogueStart!==null)continue}
    else if(ch==='”'){isQuote=true;type='curly-close'}
    else if(ch==='"'){isQuote=true;type='double'}
    else if(ch==="'"||ch==='’'||ch==='‘'){
      if(ch!=='‘'&&/[A-Za-z]/.test(prev)&&/[A-Za-z]/.test(next))continue;
      isQuote=true;type='single';
    }
    if(!isQuote)continue;
    if(dialogueStart===null){
      push(cursor,i,'narration');dialogueStart=i;quoteType=type==='curly'?'curly':type;cursor=i;
    }else{
      const closes=quoteType==='curly'?type==='curly-close':quoteType===type;
      if(closes){push(dialogueStart,i+1,'dialogue');cursor=i+1;dialogueStart=null;quoteType=null}
    }
  }
  if(dialogueStart!==null)push(dialogueStart,b,'narration');else push(cursor,b,'narration');
  return ranges.length?ranges:[{start:a,end:b,kind:'narration'}];
}
function speechPiecesForRange(source,start,end,book,settings={}){
  const pronunciations=book?.pronunciations||[];
  const ranges=settings.dialogueEnabled?dialogueRanges(source,start,end):[{start,end,kind:'narration'}];
  return ranges.map(range=>{
    const transformed=transformSpeechText(source.slice(range.start,range.end),pronunciations,range.start);
    return {...range,text:transformed.text,mapIndex:transformed.mapIndex};
  }).filter(x=>x.text);
}
function selectedReaderText(){
  try{
    const selection=window.getSelection?.();
    if(selection&&!selection.isCollapsed){
      const text=selection.toString().trim(),node=selection.anchorNode,el=node?.nodeType===1?node:node?.parentElement;
      if(text&&el?.closest?.('#readingPage')){state.selectedReaderPhrase=text;return text}
    }
  }catch{}
  return state.selectedReaderPhrase||'';
}
function pronunciationManager(book,prefill=''){
  const rows=(book.pronunciations||[]).map(p=>`<div class="pronunciation-row" data-pronunciation="${p.id}"><div><strong>${escapeHtml(p.match)}</strong><span> → “${escapeHtml(p.replacement)}”</span></div><div class="row"><button type="button" class="ghost tiny" data-pron-edit="${p.id}">Edit</button><button type="button" class="ghost tiny danger-ghost" data-pron-delete="${p.id}">Delete</button></div></div>`).join('');
  modalForm.innerHTML=`<h3>Pronunciations</h3><p class="sub">Storyline changes only what the voice says. Your manuscript text stays untouched.</p>
    <div class="pronunciation-add"><input id="pronMatch" class="select" maxlength="100" placeholder="Word or phrase" value="${escapeHtml(prefill)}" /><input id="pronReplacement" class="select" maxlength="160" placeholder="Say it as…" /></div>
    <div class="row between"><span class="meta">${(book.pronunciations||[]).length}/200 saved</span><button type="button" id="pronSave" class="button">Add pronunciation</button></div>
    <div class="pronunciation-list">${rows||'<div class="empty">No custom pronunciations yet.</div>'}</div>
    <div class="row between"><span class="meta">Longest matching phrase wins.</span><button value="default" class="ghost">Close</button></div>`;
  if(!modal.open)modal.showModal();
  const saveEntry=async(existingId=null)=>{
    const match=$('#pronMatch').value.trim(),replacement=$('#pronReplacement').value.trim();
    if(!match||!replacement){showToast('Add both the written form and how it should sound.');return}
    const list=[...(book.pronunciations||[])];
    if(!existingId&&list.length>=200){showToast('This book already has 200 pronunciations.');return}
    const duplicate=list.find(x=>x.id!==existingId&&x.match.toLowerCase()===match.toLowerCase());
    if(duplicate){showToast('That pronunciation already exists.');return}
    const found=list.find(x=>x.id===existingId);
    if(found){found.match=match;found.replacement=replacement;found.updatedAt=new Date().toISOString()}
    else list.push({id:uid(),match,replacement,createdAt:new Date().toISOString()});
    book.pronunciations=list;book.updatedAt=new Date().toISOString();await idbPut('books',book);
    if(state.bookId===book.id)state.readerBook=book;
    pronunciationManager(book);
    if(state.isSpeaking)restartNarrationForSettingChange('Pronunciation updated');
  };
  $('#pronSave').onclick=()=>saveEntry();
  $$('[data-pron-edit]').forEach(btn=>btn.onclick=()=>{
    const p=(book.pronunciations||[]).find(x=>x.id===btn.dataset.pronEdit);if(!p)return;
    $('#pronMatch').value=p.match;$('#pronReplacement').value=p.replacement;
    $('#pronSave').textContent='Save change';$('#pronSave').onclick=()=>saveEntry(p.id);
  });
  $$('[data-pron-delete]').forEach(btn=>btn.onclick=async()=>{
    book.pronunciations=(book.pronunciations||[]).filter(x=>x.id!==btn.dataset.pronDelete);
    book.updatedAt=new Date().toISOString();await idbPut('books',book);if(state.bookId===book.id)state.readerBook=book;pronunciationManager(book);
    if(state.isSpeaking)restartNarrationForSettingChange('Pronunciation removed');
  });
  requestAnimationFrame(()=>$('#pronReplacement')?.focus());
}
function excerpt(s,n=180){ const x=(s||'').trim(); return x.length>n?x.slice(0,n-1)+'…':x; }
function anchorNormalize(s=''){
  return String(s).normalize?.('NFKC').toLowerCase()
    .replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,'-')
    .replace(/\s+/g,' ').trim() || String(s).toLowerCase().replace(/\s+/g,' ').trim();
}
function anchorHash(s=''){
  const text=anchorNormalize(s);let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}
  return (h>>>0).toString(36);
}
function chapterAnchorKey(ch,book){
  return anchorHash(ch?.synthetic||ch?.title==='Beginning'||ch?.title==='Front matter'?(book?.title||'front matter'):(ch?.title||'chapter'));
}
function sentenceAtOffset(text,offset){
  const segments=sentenceSegments(text,0);if(!segments.length)return null;
  const o=Math.max(0,Math.min(Number(offset)||0,String(text||'').length));
  return segments.find(s=>o>=s.start&&o<s.end)||segments.find(s=>s.start>=o)||segments[segments.length-1];
}
function passageContext(text,start,end,span=120){
  const source=String(text||''),a=Math.max(0,Math.min(start,source.length)),b=Math.max(a,Math.min(end,source.length));
  return {prefix:source.slice(Math.max(0,a-span),a),selected:source.slice(a,b),suffix:source.slice(b,Math.min(source.length,b+span))};
}
function base64UrlEncodeUtf8(text=''){
  const bytes=new TextEncoder().encode(String(text));let binary='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlDecodeUtf8(value=''){
  const raw=String(value).replace(/-/g,'+').replace(/_/g,'/');
  const padded=raw+'='.repeat((4-raw.length%4)%4);
  const binary=atob(padded),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function meaningfulChapterTitles(book){
  return (book?.chapters||[]).map(ch=>chapterLabel(ch,book)).filter(Boolean).map(anchorNormalize);
}
function portableFingerprint(text=''){
  const value=String(text);
  return anchorHash('a|'+value)+anchorHash('b|'+value);
}
function storylineBookFingerprint(book){
  const titles=meaningfulChapterTitles(book);
  const first=titles[0]||'',last=titles[titles.length-1]||'';
  return portableFingerprint('storyline-book|'+anchorNormalize(book?.title||'')+'|'+first+'|'+last);
}
function storylineEditionFingerprint(book){
  const chapters=book?.chapters||[];
  const sample=[];
  if(chapters.length){
    const indices=[0,Math.floor((chapters.length-1)/2),chapters.length-1];
    for(const ci of [...new Set(indices)]){
      const ch=chapters[ci],paras=ch?.paragraphs||[];
      sample.push(chapterAnchorKey(ch,book));
      if(paras.length){
        const pi=[0,Math.floor((paras.length-1)/2),paras.length-1];
        for(const i of [...new Set(pi)])sample.push(anchorHash(paras[i]||''));
      }
    }
  }
  return portableFingerprint('storyline-edition|'+chapters.length+'|'+sample.join('|'));
}
function compactHandoffAnchor(anchor){
  if(!anchor)return null;
  return {
    ck:anchor.chapterKey||'',pf:anchor.paragraphFingerprint||'',
    s:String(anchor.selectedText||'').slice(0,140),
    p:String(anchor.prefixContext||'').slice(-72),
    x:String(anchor.suffixContext||'').slice(0,72),
    cs:Number(anchor.charStart)||0,ce:Number(anchor.charEnd)||0,
    pp:anchor.previousParagraphFingerprint||'',np:anchor.nextParagraphFingerprint||''
  };
}
function expandHandoffAnchor(packet){
  const a=packet?.anchor;if(!a||typeof a!=='object')return null;
  return {
    version:1,precision:'word',
    chapterKey:String(a.ck||''),chapterTitle:String(packet.title||''),chapterIndex:Number(packet.chapter)||0,
    paragraphIndex:Number(packet.paragraph)||0,paragraphFingerprint:String(a.pf||''),
    charStart:Number(a.cs)||0,charEnd:Number(a.ce)||Number(a.cs)||0,
    selectedText:String(a.s||''),selectionFingerprint:a.s?anchorHash(a.s):'',
    prefixContext:String(a.p||''),suffixContext:String(a.x||''),
    previousParagraphFingerprint:String(a.pp||''),nextParagraphFingerprint:String(a.np||''),
    capturedAt:String(packet.ts||new Date().toISOString())
  };
}
function handoffPosition(book){
  const ci=Math.max(0,Math.min(state.chapterIndex,(book?.chapters?.length||1)-1));
  const ch=book?.chapters?.[ci],pi=Math.max(0,Math.min(state.selectedParagraph,(ch?.paragraphs?.length||1)-1));
  const text=String(ch?.paragraphs?.[pi]||'');
  let offset=(state.isSpeaking&&state.speakingPIndex===pi&&Number.isFinite(state.liveCharOffset))?state.liveCharOffset:(state.selectedCharOffset||0);
  offset=Math.max(0,Math.min(Number(offset)||0,text.length));
  const word=wordRangeAt(text,offset),end=Math.max(offset,Math.min(word.end||offset,text.length));
  return {chapterIndex:ci,paragraphIndex:pi,charOffset:offset,wordEnd:end,text,ch};
}
function makeHandoffPacket(book){
  const pos=handoffPosition(book);
  const anchor=makePassageAnchor(book,pos.ch,pos.paragraphIndex,pos.text,{start:pos.charOffset,end:pos.wordEnd,precision:'word'});
  const ctx=passageContext(pos.text,pos.charOffset,pos.wordEnd,58);
  return {
    app:'storyline-handoff',v:1,
    bookFingerprint:storylineBookFingerprint(book),
    editionFingerprint:storylineEditionFingerprint(book),
    title:String(book?.title||'Manuscript').slice(0,90),
    chapter:pos.chapterIndex,paragraph:pos.paragraphIndex,
    charOffset:pos.charOffset,wordEnd:pos.wordEnd,
    anchor:compactHandoffAnchor(anchor),
    excerpt:(ctx.prefix+ctx.selected+ctx.suffix).replace(/\s+/g,' ').trim().slice(0,150),
    ts:new Date().toISOString()
  };
}
function encodeHandoffPacket(packet){
  return 'storyline://h1.'+base64UrlEncodeUtf8(JSON.stringify(packet));
}
function handoffWebUrl(code){
  try{
    const url=new URL(location.href);
    url.hash='handoff='+encodeURIComponent(code);
    return url.toString();
  }catch{return code}
}
function extractHandoffCode(value=''){
  const raw=String(value||'').trim();if(!raw)return '';
  if(raw.startsWith('storyline://h1.'))return raw;
  try{
    const url=new URL(raw,location.href);
    const hash=url.hash||'';
    if(hash.startsWith('#handoff='))return decodeURIComponent(hash.slice(9));
  }catch{}
  const marker='#handoff=',i=raw.indexOf(marker);
  if(i>=0){try{return decodeURIComponent(raw.slice(i+marker.length))}catch{}}
  return '';
}
function decodeHandoffPacket(value=''){
  try{
    const code=extractHandoffCode(value);
    if(!code||!code.startsWith('storyline://h1.'))return null;
    const packet=JSON.parse(base64UrlDecodeUtf8(code.slice('storyline://h1.'.length)));
    if(packet?.app!=='storyline-handoff'||Number(packet.v)!==1)return null;
    for(const key of ['chapter','paragraph','charOffset','wordEnd'])if(!Number.isFinite(Number(packet[key])))return null;
    if(typeof packet.title!=='string'||typeof packet.bookFingerprint!=='string'||typeof packet.editionFingerprint!=='string')return null;
    if(packet.title.length>180||packet.bookFingerprint.length>80||packet.editionFingerprint.length>80||String(packet.excerpt||'').length>400)return null;
    if(packet.anchor&&typeof packet.anchor!=='object')return null;
    if(packet.anchor){
      for(const key of ['ck','pf','s','p','x','pp','np'])if(String(packet.anchor[key]||'').length>240)return null;
      for(const key of ['cs','ce'])if(packet.anchor[key]!==undefined&&!Number.isFinite(Number(packet.anchor[key])))return null;
    }
    packet.chapter=Math.max(0,Math.floor(Number(packet.chapter)));
    packet.paragraph=Math.max(0,Math.floor(Number(packet.paragraph)));
    packet.charOffset=Math.max(0,Math.floor(Number(packet.charOffset)));
    packet.wordEnd=Math.max(packet.charOffset,Math.floor(Number(packet.wordEnd)));
    return packet;
  }catch{return null}
}
function bookLastTouched(book){
  return Date.parse(book?.progress?.updatedAt||book?.updatedAt||book?.createdAt||0)||0;
}
async function matchHandoffBook(packet){
  const books=await idbGetAll('books');
  const edition=books.filter(b=>storylineEditionFingerprint(b)===packet.editionFingerprint);
  const sameBook=books.filter(b=>storylineBookFingerprint(b)===packet.bookFingerprint);
  const sameTitle=books.filter(b=>anchorNormalize(b.title)===anchorNormalize(packet.title));
  const candidates=edition.length?edition:sameBook.length?sameBook:sameTitle;
  candidates.sort((a,b)=>bookLastTouched(b)-bookLastTouched(a));
  return {book:candidates[0]||null,exactEdition:!!edition.length,multiple:candidates.length>1,matchKind:edition.length?'edition':sameBook.length?'book':sameTitle.length?'title':'none'};
}
function resolveHandoffPosition(book,packet,exactEdition=false){
  const maxCi=Math.max(0,(book?.chapters?.length||1)-1);
  const fallbackCi=Math.max(0,Math.min(packet.chapter,maxCi)),fallbackCh=book.chapters[fallbackCi];
  const fallbackPi=Math.max(0,Math.min(packet.paragraph,Math.max(0,(fallbackCh?.paragraphs?.length||1)-1)));
  const fallbackText=String(fallbackCh?.paragraphs?.[fallbackPi]||'');
  const fallbackStart=Math.max(0,Math.min(packet.charOffset,fallbackText.length));
  const fallbackEnd=Math.max(fallbackStart,Math.min(packet.wordEnd,fallbackText.length));
  const expanded=expandHandoffAnchor(packet);
  if(!expanded)return {chapterIndex:fallbackCi,paragraphIndex:fallbackPi,start:fallbackStart,end:fallbackEnd,adjusted:!exactEdition,score:0};
  const resolved=resolvePassageAnchor(book,{chapterIndex:packet.chapter,paragraphIndex:packet.paragraph,charOffset:packet.charOffset,wordEnd:packet.wordEnd,anchor:expanded});
  if(!resolved||resolved.unverified){
    return {chapterIndex:fallbackCi,paragraphIndex:fallbackPi,start:fallbackStart,end:fallbackEnd,adjusted:!exactEdition||fallbackCi!==packet.chapter||fallbackPi!==packet.paragraph||fallbackStart!==packet.charOffset,score:resolved?.score||0};
  }
  return {...resolved,adjusted:!exactEdition||!!resolved.moved};
}
function handoffDisplayLocation(book,pos){
  const ch=book?.chapters?.[pos.chapterIndex];
  return `${chapterLabel(ch,book)} · paragraph ${pos.paragraphIndex+1}`;
}
function stopHandoffScanner(){
  const stop=state.handoffScanStop;state.handoffScanStop=null;
  try{stop?.()}catch{}
}
function makePassageAnchor(book,ch,paragraphIndex,text,{start=0,end=0,spokenSegment=null,precision='sentence'}={}){
  const source=String(text||'');let a=start,b=end,kind=precision;
  if(spokenSegment&&spokenSegment.start>=0&&spokenSegment.end>spokenSegment.start){
    a=spokenSegment.start;b=spokenSegment.end;kind='sentence';
  }else if(precision==='sentence'){
    const seg=sentenceAtOffset(source,a);
    if(seg){a=seg.start;b=seg.end}else{const w=wordRangeAt(source,a);a=w.start;b=w.end;kind='word'}
  }else{
    a=Math.max(0,Math.min(a,source.length));b=Math.max(a,Math.min(b||a,source.length));
  }
  const ctx=passageContext(source,a,b);
  return {
    version:1,precision:kind,
    chapterKey:chapterAnchorKey(ch,book),chapterTitle:chapterLabel(ch,book),chapterIndex:state.chapterIndex,
    paragraphIndex,paragraphFingerprint:anchorHash(source),
    charStart:a,charEnd:b,selectedText:ctx.selected,selectionFingerprint:ctx.selected?anchorHash(ctx.selected):'',
    prefixContext:ctx.prefix,suffixContext:ctx.suffix,
    previousParagraphFingerprint:paragraphIndex>0?anchorHash(ch.paragraphs[paragraphIndex-1]||''):'',
    nextParagraphFingerprint:paragraphIndex<ch.paragraphs.length-1?anchorHash(ch.paragraphs[paragraphIndex+1]||''):'',
    capturedAt:new Date().toISOString()
  };
}
function makeLegacyPassageAnchor(book,ch,item){
  const pi=Math.max(0,Math.min(item.paragraphIndex??0,ch.paragraphs.length-1)),text=ch.paragraphs[pi]||'';
  const a=Math.max(0,Math.min(item.charOffset||0,text.length)),b=Math.max(a,Math.min(item.wordEnd||a,text.length));
  const ctx=passageContext(text,a,b);
  return {
    version:1,precision:'paragraph',legacy:true,
    chapterKey:chapterAnchorKey(ch,book),chapterTitle:chapterLabel(ch,book),chapterIndex:item.chapterIndex??0,
    paragraphIndex:pi,paragraphFingerprint:anchorHash(text),
    charStart:a,charEnd:b,selectedText:ctx.selected,selectionFingerprint:ctx.selected?anchorHash(ctx.selected):'',
    prefixContext:ctx.prefix,suffixContext:ctx.suffix,
    previousParagraphFingerprint:pi>0?anchorHash(ch.paragraphs[pi-1]||''):'',
    nextParagraphFingerprint:pi<ch.paragraphs.length-1?anchorHash(ch.paragraphs[pi+1]||''):'',
    legacyExcerpt:item.excerpt||'',capturedAt:item.createdAt||new Date().toISOString()
  };
}
function allOccurrences(haystack,needle){
  const out=[];if(!needle)return out;let from=0;
  while(from<=haystack.length){const i=haystack.indexOf(needle,from);if(i<0)break;out.push(i);from=i+Math.max(1,needle.length)}
  return out;
}
function contextTokenSimilarity(a,b){
  const ta=new Set(anchorNormalize(a).match(/[a-z0-9']+/g)||[]);
  const tb=new Set(anchorNormalize(b).match(/[a-z0-9']+/g)||[]);
  if(!ta.size||!tb.size)return 0;
  let common=0;for(const token of ta)if(tb.has(token))common++;
  return (2*common)/(ta.size+tb.size);
}
function contextScore(source,index,length,anchor){
  let score=0;
  const before=anchorNormalize(source.slice(Math.max(0,index-120),index));
  const after=anchorNormalize(source.slice(index+length,index+length+120));
  const wantBefore=anchorNormalize(anchor.prefixContext||'').slice(-120);
  const wantAfter=anchorNormalize(anchor.suffixContext||'').slice(0,120);
  if(wantBefore&&before.endsWith(wantBefore))score+=24;
  else if(wantBefore.length>=18&&before.includes(wantBefore.slice(-30)))score+=12;
  if(wantAfter&&after.startsWith(wantAfter))score+=24;
  else if(wantAfter.length>=18&&after.includes(wantAfter.slice(0,30)))score+=12;
  score+=Math.round(contextTokenSimilarity(before,wantBefore)*22);
  score+=Math.round(contextTokenSimilarity(after,wantAfter)*22);
  return score;
}
function bestSelectionInParagraph(source,anchor){
  const selected=String(anchor.selectedText||'');if(!selected)return {start:anchor.charStart||0,end:anchor.charEnd||anchor.charStart||0,score:0};
  let hits=allOccurrences(source,selected),caseInsensitive=false;
  if(!hits.length){hits=allOccurrences(source.toLowerCase(),selected.toLowerCase());caseInsensitive=true}
  if(!hits.length)return {start:anchor.charStart||0,end:anchor.charEnd||anchor.charStart||0,score:0};
  let best=null;
  for(const start of hits){
    const score=42+contextScore(source,start,selected.length,anchor)-(caseInsensitive?2:0);
    if(!best||score>best.score)best={start,end:start+selected.length,score};
  }
  return best;
}
function scorePassageCandidate(book,ch,ci,pi,anchor){
  const source=ch.paragraphs[pi]||'',fp=anchorHash(source),selection=bestSelectionInParagraph(source,anchor);
  let score=selection.score;
  if(fp===anchor.paragraphFingerprint)score+=110;
  if(chapterAnchorKey(ch,book)===anchor.chapterKey)score+=36;
  if(pi>0&&anchor.previousParagraphFingerprint&&anchorHash(ch.paragraphs[pi-1]||'')===anchor.previousParagraphFingerprint)score+=18;
  if(pi<ch.paragraphs.length-1&&anchor.nextParagraphFingerprint&&anchorHash(ch.paragraphs[pi+1]||'')===anchor.nextParagraphFingerprint)score+=18;
  if(ci===anchor.chapterIndex)score+=8;
  score-=Math.min(18,Math.abs(pi-(anchor.paragraphIndex||0))*.3);
  if(anchor.legacyExcerpt&&anchorNormalize(source).includes(anchorNormalize(anchor.legacyExcerpt).slice(0,80)))score+=32;
  let start=selection.start,end=selection.end;
  if(fp===anchor.paragraphFingerprint&&anchor.precision==='paragraph'){
    start=Math.max(0,Math.min(anchor.charStart||0,source.length));
    end=Math.max(start,Math.min(anchor.charEnd||start,source.length));
  }
  return {chapterIndex:ci,paragraphIndex:pi,start,end,score,paragraphFingerprint:fp};
}
function resolvePassageAnchor(book,item){
  const anchor=item.anchor;
  if(!anchor){
    const ci=Math.max(0,Math.min(item.chapterIndex??0,book.chapters.length-1)),ch=book.chapters[ci];
    const pi=Math.max(0,Math.min(item.paragraphIndex??0,(ch?.paragraphs.length||1)-1));
    return {chapterIndex:ci,paragraphIndex:pi,start:item.charOffset||0,end:item.wordEnd||item.charOffset||0,score:1,moved:false,legacy:true};
  }
  let best=null;
  for(let ci=0;ci<book.chapters.length;ci++){
    const ch=book.chapters[ci];
    for(let pi=0;pi<ch.paragraphs.length;pi++){
      const candidate=scorePassageCandidate(book,ch,ci,pi,anchor);
      if(!best||candidate.score>best.score)best=candidate;
    }
  }
  if(!best||best.score<34){
    const ci=Math.max(0,Math.min(anchor.chapterIndex??item.chapterIndex??0,book.chapters.length-1)),ch=book.chapters[ci];
    const pi=Math.max(0,Math.min(anchor.paragraphIndex??item.paragraphIndex??0,(ch?.paragraphs.length||1)-1));
    best={chapterIndex:ci,paragraphIndex:pi,start:anchor.charStart||0,end:anchor.charEnd||anchor.charStart||0,score:0,unverified:true};
  }
  best.moved=best.chapterIndex!==(anchor.chapterIndex??item.chapterIndex)||best.paragraphIndex!==(anchor.paragraphIndex??item.paragraphIndex);
  return best;
}
function referenceExcerptHtml(item){
  const a=item.anchor;if(!a)return escapeHtml(item.excerpt||'');
  const before=excerpt(a.prefixContext||'',80),selected=a.selectedText||'',after=excerpt(a.suffixContext||'',80);
  if(!selected)return escapeHtml(item.excerpt||a.legacyExcerpt||'');
  return `${before?'…'+escapeHtml(before)+' ':''}<mark class="passage-anchor-text">${escapeHtml(selected)}</mark>${after?' '+escapeHtml(after)+'…':''}`;
}
function markReferenceRange(paragraphIndex,start,end){
  const p=$(`#readingPage p[data-p="${paragraphIndex}"]`);if(!p)return;
  const text=p.textContent||'',a=Math.max(0,Math.min(start,text.length)),b=Math.max(a,Math.min(end||a,text.length));
  if(b>a)p.innerHTML=escapeHtml(text.slice(0,a))+`<span class="passage-reference">${escapeHtml(text.slice(a,b))}</span>`+escapeHtml(text.slice(b));
  p.classList.add('reference-target');
}
async function migrateLegacyPassageAnchors(){
  const items=await idbGetAll('items');
  const books=await idbGetAll('books');
  const bookMap=Object.fromEntries(books.map(b=>[b.id,b]));
  let migrated=0;
  for(const item of items){
    if(item.anchor)continue;
    const book=bookMap[item.bookId];if(!book||!book.chapters?.length)continue;
    const ci=Math.max(0,Math.min(item.chapterIndex??0,book.chapters.length-1));
    const ch=book.chapters[ci];if(!ch?.paragraphs?.length)continue;
    item.anchor=makeLegacyPassageAnchor(book,ch,{...item,chapterIndex:ci});
    item.anchorMigratedAt=new Date().toISOString();
    await idbPut('items',item);migrated++;
  }
  return migrated;
}
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
  const sentence=p.querySelector('.sentence-speaking');
  followNarrationElement(sentence||p);
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

function splitChapters(paragraphs,sources=null){
  const chapters=[]; let current={title:'Front matter', paragraphs:[],synthetic:true,sourceRefs:[]};
  const heading=/^(chapter\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[a-z-]+)|prologue|epilogue)\b/i;
  for(let index=0;index<paragraphs.length;index++){
    const raw=paragraphs[index],p=raw.trim(),source=sources?.[index]||null;if(!p)continue;
    if(heading.test(p)&&current.paragraphs.length){
      chapters.push(current);current={title:p,paragraphs:[],synthetic:false,sourceRefs:[],titleSource:source};
    }else if(heading.test(p)&&!current.paragraphs.length){
      current.title=p;current.synthetic=false;current.titleSource=source;
    }else{
      current.paragraphs.push(p);current.sourceRefs.push(source);
    }
  }
  if(current.paragraphs.length)chapters.push(current);
  if(!chapters.length)chapters.push({title:'Manuscript',paragraphs:paragraphs.filter(Boolean),sourceRefs:sources?paragraphs.map((p,i)=>p?sources[i]||null:null).filter((_,i)=>paragraphs[i]):[]});
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
function ensureTesseractLibrary(){
  if(window.Tesseract?.createWorker)return Promise.resolve(window.Tesseract);
  if(ensureTesseractLibrary.promise)return ensureTesseractLibrary.promise;
  ensureTesseractLibrary.promise=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.async=true;s.crossOrigin='anonymous';
    s.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('OCR engine did not initialise.'));
    s.onerror=()=>reject(new Error('OCR setup could not download. Connect to the internet once, then try again.'));
    document.head.appendChild(s);
  }).catch(e=>{ensureTesseractLibrary.promise=null;throw e});
  return ensureTesseractLibrary.promise;
}
function confirmPdfOcr(count,total){
  return new Promise(resolve=>{
    modalForm.innerHTML=`<h3>Scanned pages found</h3>
      <p>Storyline found <strong>${count}</strong> page${count===1?'':'s'} with little or no selectable text out of ${total}.</p>
      <p class="sub">OCR runs on this device. The first OCR use may need an internet connection to download the free OCR engine and English language data; later uses can reuse cached data.</p>
      <div class="row between"><button type="button" id="skipPdfOcr" class="ghost">Import text pages only</button><button type="button" id="runPdfOcr" class="button">Read scanned pages with OCR</button></div>`;
    if(!modal.open)modal.showModal();
    let settled=false;
    const finish=v=>{if(settled)return;settled=true;modal.onclose=null;if(modal.open)modal.close();resolve(v)};
    $('#skipPdfOcr').onclick=()=>finish(false);
    $('#runPdfOcr').onclick=()=>finish(true);
    modal.onclose=()=>finish(false);
  });
}
function ocrTextToSyntheticLines(text,pageNo,confidence=0){
  const rows=String(text||'').replace(/\r/g,'').split('\n');
  const lines=[];let y=820;
  for(const raw of rows){
    if(!raw.trim()){y-=22;continue}
    const leading=(raw.match(/^\s+/)?.[0].length||0),clean=raw.replace(/\s+/g,' ').trim();
    if(!clean)continue;
    const x=72+Math.min(24,leading*3);
    lines.push({pageNo,y,xStart:x,xEnd:x+Math.max(40,clean.length*6),height:12,text:clean,ocr:true,confidence:Number(confidence)||0});
    y-=14;
  }
  return lines;
}
async function renderPdfPageForOcr(page){
  const base=page.getViewport({scale:1}),targetWidth=Math.min(2200,Math.max(1500,base.width*2));
  const scale=targetWidth/base.width,viewport=page.getViewport({scale});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  await page.render({canvasContext:ctx,viewport,background:'white'}).promise;
  return canvas;
}
async function ocrPdfPages(pdf,pageNumbers){
  const Tesseract=await ensureTesseractLibrary();
  let cancelled=false,worker=null,currentPage=0,currentStatus='Preparing OCR…';
  modalForm.innerHTML=`<h3>Reading scanned pages</h3><p id="ocrProgressText" class="sub">Preparing OCR…</p><progress id="ocrProgressBar" max="${pageNumbers.length}" value="0"></progress><div class="row between"><span class="meta">Keep Storyline open while OCR is running.</span><button type="button" id="cancelOcr" class="ghost">Cancel OCR</button></div>`;
  if(!modal.open)modal.showModal();
  $('#cancelOcr').onclick=()=>{cancelled=true;$('#ocrProgressText').textContent='Stopping after the current OCR step…'};
  modal.onclose=()=>{cancelled=true};
  const updateLogger=m=>{
    const el=$('#ocrProgressText');if(!el)return;
    if(m?.status==='recognizing text'&&Number.isFinite(m.progress)){
      el.textContent=`OCR page ${currentPage} of ${pageNumbers.length} · ${Math.round(m.progress*100)}%`;
    }else if(m?.status)el.textContent=`OCR page ${currentPage||1} of ${pageNumbers.length} · ${m.status}`;
  };
  const results=[];
  try{
    worker=await Tesseract.createWorker('eng',1,{logger:updateLogger});
    for(let i=0;i<pageNumbers.length;i++){
      if(cancelled)break;
      currentPage=i+1;const pageNo=pageNumbers[i],page=await pdf.getPage(pageNo),canvas=await renderPdfPageForOcr(page);
      const el=$('#ocrProgressText');if(el)el.textContent=`OCR page ${i+1} of ${pageNumbers.length}`;
      const result=await worker.recognize(canvas);
      if(cancelled)break;
      const text=String(result?.data?.text||'').trim(),confidence=Number(result?.data?.confidence)||0;
      results.push({pageNo,text,confidence,lines:ocrTextToSyntheticLines(text,pageNo,confidence)});
      const bar=$('#ocrProgressBar');if(bar)bar.value=i+1;
      await new Promise(requestAnimationFrame);
    }
  }finally{
    try{await worker?.terminate?.()}catch{}
    modal.onclose=null;if(modal.open)modal.close();
  }
  return {results,cancelled};
}
function pdfSourceLabel(source){
  if(!source?.pages?.length)return '';
  const pages=source.pages;
  const pageText=pages.length===1?`PDF page ${pages[0]}`:`PDF pages ${pages[0]}–${pages[pages.length-1]}`;
  return source.ocr?`${pageText} · OCR`:pageText;
}
function importDiagnosticsHtml(book){
  const d=book?.importDiagnostics;if(!d)return '';
  const parts=[];
  if(d.format)parts.push(d.format.toUpperCase());
  if(Number.isFinite(d.totalPages))parts.push(`${d.totalPages} page${d.totalPages===1?'':'s'}`);
  if(d.ocrPages?.length)parts.push(`${d.ocrPages.length} OCR`);
  if(d.skippedOcrPages?.length)parts.push(`${d.skippedOcrPages.length} scanned page${d.skippedOcrPages.length===1?'':'s'} skipped`);
  if(d.lowConfidencePages?.length)parts.push(`${d.lowConfidencePages.length} low-confidence OCR`);
  return parts.join(' · ');
}
function showImportReport(book){
  const d=book?.importDiagnostics;if(!d)return;
  const report=importDiagnosticsHtml(book);
  modalForm.innerHTML=`<h3>Import complete</h3><p><strong>${escapeHtml(book.title)}</strong></p>
    <p class="sub">${book.chapters.length} chapter${book.chapters.length===1?'':'s'} · ${book.chapters.reduce((n,ch)=>n+ch.paragraphs.length,0)} paragraphs${report?' · '+escapeHtml(report):''}</p>
    ${d.ocrPages?.length?`<p>${d.ocrPages.length} page${d.ocrPages.length===1?' was':'s were'} reconstructed with OCR.</p>`:''}
    ${d.lowConfidencePages?.length?`<p class="import-warning">Review OCR text from page${d.lowConfidencePages.length===1?'':'s'} ${d.lowConfidencePages.join(', ')}; recognition confidence was lower there.</p>`:''}
    ${d.skippedOcrPages?.length?`<p class="import-warning">Scanned page${d.skippedOcrPages.length===1?'':'s'} ${d.skippedOcrPages.join(', ')} were not imported because OCR was skipped or cancelled.</p>`:''}
    <div class="row between"><span class="meta">Source page references stay attached to reconstructed paragraphs.</span><button value="default" class="button">Open manuscript</button></div>`;
  if(!modal.open)modal.showModal();
}
function pdfMedian(values){
  const nums=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!nums.length)return 0;
  const m=Math.floor(nums.length/2);
  return nums.length%2?nums[m]:(nums[m-1]+nums[m])/2;
}
function pdfHeadingLike(text){
  const t=String(text||'').trim();
  return /^(?:chapter\s+(?:\d+|[ivxlcdm]+|[a-z][a-z -]*|one|two|three|four|five|six|seven|eight|nine|ten)|prologue|epilogue|part\s+(?:\d+|[ivxlcdm]+|[a-z][a-z -]*))\b/i.test(t)&&t.length<=120;
}
function pdfPageNumberLike(text){
  const t=String(text||'').trim();
  return /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(t)||/^[ivxlcdm]{1,8}$/i.test(t);
}
function pdfLineSignature(text){
  return anchorNormalize(text).replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
}
function pdfCleanLineText(items){
  const sorted=[...items].sort((a,b)=>a.x-b.x);
  let out='';
  for(const item of sorted){
    const part=String(item.text||'').replace(/\s+/g,' ').trim();
    if(!part)continue;
    if(!out){out=part;continue}
    const prev=out.slice(-1),first=part[0];
    const noSpaceBefore=/[,.;:!?%)\]}”’]/.test(first);
    const noSpaceAfter=/[(\[{“‘]/.test(prev);
    out+=(noSpaceBefore||noSpaceAfter?'':' ')+part;
  }
  return out.replace(/\s+([,.;:!?%)\]}”’])/g,'$1').replace(/([(\[{“‘])\s+/g,'$1').replace(/\s+/g,' ').trim();
}
function pdfGroupPageLines(content,pageNo){
  const raw=content.items.map(item=>{
    const text=String(item.str||'').trim();
    const tr=item.transform||[];
    const x=Number(tr[4]||0),y=Number(tr[5]||0);
    const height=Math.abs(Number(item.height||tr[3]||tr[0]||10))||10;
    const width=Math.abs(Number(item.width||0));
    return text?{text,x,y,height,width}:null;
  }).filter(Boolean).sort((a,b)=>Math.abs(b.y-a.y)>2?b.y-a.y:a.x-b.x);
  if(!raw.length)return [];
  const medianHeight=pdfMedian(raw.map(x=>x.height))||10;
  const tolerance=Math.max(1.5,medianHeight*.32);
  const lines=[];
  for(const item of raw){
    let line=lines.find(l=>Math.abs(l.y-item.y)<=tolerance);
    if(!line){line={pageNo,y:item.y,items:[],xStart:item.x,xEnd:item.x+item.width,height:item.height};lines.push(line)}
    line.items.push(item);
    line.xStart=Math.min(line.xStart,item.x);
    line.xEnd=Math.max(line.xEnd,item.x+item.width);
    line.height=Math.max(line.height,item.height);
  }
  return lines.sort((a,b)=>b.y-a.y||a.xStart-b.xStart).map(line=>({...line,text:pdfCleanLineText(line.items)})).filter(x=>x.text);
}
function pdfRepeatedMarginSignatures(pages){
  const counts=new Map();
  for(const lines of pages){
    const candidates=[...lines.slice(0,2),...lines.slice(-2)];
    const seen=new Set();
    for(const line of candidates){
      if(!line?.text||line.text.length>120||pdfPageNumberLike(line.text))continue;
      const sig=pdfLineSignature(line.text);if(!sig||seen.has(sig))continue;
      seen.add(sig);counts.set(sig,(counts.get(sig)||0)+1);
    }
  }
  const threshold=Math.max(2,Math.ceil(pages.length*.5));
  return new Set([...counts].filter(([,count])=>count>=threshold).map(([sig])=>sig));
}
function pdfJoinLinesToRecords(pages){
  const repeated=pdfRepeatedMarginSignatures(pages);
  const all=[];
  for(const lines of pages){
    const usable=lines.filter(line=>!pdfPageNumberLike(line.text)&&!repeated.has(pdfLineSignature(line.text)));
    if(!usable.length)continue;
    const gaps=[];
    for(let i=0;i<usable.length-1;i++){
      const gap=usable[i].y-usable[i+1].y;
      if(gap>0&&gap<100)gaps.push(gap);
    }
    const normalGap=pdfMedian(gaps)||pdfMedian(usable.map(x=>x.height))||12;
    const starts=usable.filter(x=>!pdfHeadingLike(x.text)).map(x=>x.xStart).filter(Number.isFinite).sort((a,b)=>a-b);
    const leftEdge=starts.length?starts[Math.floor((starts.length-1)*.2)]:0;
    usable.forEach((line,index)=>all.push({...line,normalGap,leftEdge,pageBreak:index===0&&all.length>0}));
  }

  const records=[];let current='',pagesUsed=new Set(),ocrUsed=false,confidences=[];
  const addSource=line=>{
    if(Number.isFinite(line.pageNo))pagesUsed.add(line.pageNo);
    if(line.ocr){ocrUsed=true;if(Number.isFinite(line.confidence)&&line.confidence>0)confidences.push(line.confidence)}
  };
  const flush=()=>{
    const text=current.replace(/\s+/g,' ').trim();
    if(text){
      const pages=[...pagesUsed].sort((a,b)=>a-b);
      records.push({text,source:{type:'pdf',pages,ocr:ocrUsed,confidence:confidences.length?Math.round(confidences.reduce((a,b)=>a+b,0)/confidences.length):null}});
    }
    current='';pagesUsed=new Set();ocrUsed=false;confidences=[];
  };
  for(let i=0;i<all.length;i++){
    const line=all[i],prev=all[i-1],text=line.text.trim();
    if(!text)continue;
    if(pdfHeadingLike(text)){flush();addSource(line);current=text;flush();continue}

    let newParagraph=!current;
    if(current&&prev){
      const samePage=prev.pageNo===line.pageNo;
      const gap=samePage?prev.y-line.y:line.normalGap;
      const largeGap=samePage&&gap>Math.max(line.normalGap*1.48,line.height*1.55);
      const indented=line.xStart>=line.leftEdge+Math.max(7,line.height*.55);
      const prevWasHeading=pdfHeadingLike(prev.text);
      newParagraph=largeGap||indented||prevWasHeading;
      if(line.pageBreak&&!indented&&!largeGap&&!prevWasHeading)newParagraph=false;
    }
    if(newParagraph&&current)flush();

    addSource(line);
    if(!current){current=text;continue}
    const hyphenated=/[A-Za-zÀ-ÖØ-öø-ÿ]-$/.test(current)&&/^[a-zà-öø-ÿ]/.test(text);
    if(hyphenated)current=current.slice(0,-1)+text;
    else current+=' '+text;
  }
  flush();
  return records.filter(r=>r.text);
}
function pdfJoinLinesToParagraphs(pages){
  return pdfJoinLinesToRecords(pages).map(r=>r.text);
}
async function parsePdf(file){
  if(!window.pdfjsLib)throw new Error('PDF support has not finished loading. Check your connection and try again.');
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const pages=[],ocrCandidates=[],embeddedPages=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
    const page=await pdf.getPage(pageNo),content=await page.getTextContent();
    const lines=pdfGroupPageLines(content,pageNo),chars=lines.reduce((n,line)=>n+line.text.length,0);
    if(chars<14){ocrCandidates.push(pageNo);pages.push(lines)}
    else{embeddedPages.push(pageNo);pages.push(lines)}
  }

  let ocrPages=[],lowConfidencePages=[],skippedOcrPages=[];
  if(ocrCandidates.length){
    const useOcr=await confirmPdfOcr(ocrCandidates.length,pdf.numPages);
    if(useOcr){
      const ocr=await ocrPdfPages(pdf,ocrCandidates);
      const byPage=new Map(ocr.results.map(x=>[x.pageNo,x]));
      for(const pageNo of ocrCandidates){
        const result=byPage.get(pageNo);
        if(result?.lines?.length){
          pages[pageNo-1]=result.lines;ocrPages.push(pageNo);
          if(result.confidence&&result.confidence<70)lowConfidencePages.push(pageNo);
        }else skippedOcrPages.push(pageNo);
      }
      if(ocr.cancelled){
        for(const pageNo of ocrCandidates)if(!ocrPages.includes(pageNo)&&!skippedOcrPages.includes(pageNo))skippedOcrPages.push(pageNo);
      }
    }else skippedOcrPages=[...ocrCandidates];
  }

  const records=pdfJoinLinesToRecords(pages);
  if(!records.length){
    if(ocrCandidates.length&&skippedOcrPages.length)throw new Error('This PDF is image-based. OCR was skipped, so there is no readable text to import.');
    throw new Error('No readable manuscript text was reconstructed from this PDF.');
  }
  return {
    paragraphs:records.map(r=>r.text),
    sources:records.map(r=>r.source),
    diagnostics:{format:'pdf',totalPages:pdf.numPages,embeddedPages,ocrPages,skippedOcrPages,lowConfidencePages}
  };
}
async function importPastedText(text,title=''){
  const source=String(text||'').replace(/\r/g,'').trim();
  if(!source){showToast('Paste some manuscript text first.');return}
  const paragraphs=source.split(/\n\s*\n|\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  if(!paragraphs.length){showToast('No manuscript text was found.');return}
  let bookTitle=String(title||'').trim();
  if(!bookTitle){
    const first=paragraphs.find(p=>p.length>3)||'Pasted manuscript';
    bookTitle=excerpt(first.replace(/^(chapter\s+[^:.-]+|prologue|epilogue)\s*[:.-]?\s*/i,''),70)||'Pasted manuscript';
  }
  const chapters=splitChapters(paragraphs);
  const now=new Date().toISOString();
  const book={id:uid(),title:bookTitle,fileName:'Pasted text',createdAt:now,updatedAt:now,chapters,progress:{chapterIndex:0,paragraphIndex:0,charOffset:0,wordEnd:0,completed:false},version:'Pasted manuscript'};
  await idbPut('books',book);
  state.bookId=book.id;state.chapterIndex=0;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;
  savePrefs({lastBookId:book.id});
  showToast(`Imported ${book.chapters.length} chapter${book.chapters.length===1?'':'s'} from pasted text`);
  await navigate('reader');
}
function pastedFileFromTransfer(transfer){
  const files=[...(transfer?.files||[])];
  if(files.length)return files[0];
  const items=[...(transfer?.items||[])];
  const fileItem=items.find(item=>item.kind==='file');
  return fileItem?.getAsFile?.()||null;
}
function openPasteImport(initialText=''){
  modalForm.innerHTML=`<h3>Paste manuscript</h3>
    <p class="sub">Paste manuscript text below, or paste/drop a copied manuscript file here.</p>
    <input id="pasteTitle" class="select" type="text" placeholder="Title (optional)" />
    <textarea id="pasteManuscriptText" class="paste-manuscript-text" placeholder="Paste manuscript text here…">${escapeHtml(initialText)}</textarea>
    <div id="pasteFileDrop" class="paste-file-drop" tabindex="0">Paste or drop a DOCX, EPUB, PDF, ODT, Markdown, HTML, or TXT file here</div>
    <div class="row between"><button value="cancel" class="button secondary">Cancel</button><button type="button" id="importPastedTextBtn" class="button">Import pasted text</button></div>`;
  modal.showModal();
  const textarea=$('#pasteManuscriptText'),drop=$('#pasteFileDrop');
  const handleTransfer=async transfer=>{
    const file=pastedFileFromTransfer(transfer);
    if(file){modal.close();await importFile(file);return true}
    const text=transfer?.getData?.('text/plain')||'';
    if(text){textarea.value=text;return true}
    return false;
  };
  textarea.onpaste=async e=>{
    const file=pastedFileFromTransfer(e.clipboardData);
    if(file){e.preventDefault();modal.close();await importFile(file)}
  };
  drop.onpaste=async e=>{e.preventDefault();if(!await handleTransfer(e.clipboardData))showToast('No text or supported file was found on the clipboard.')};
  drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag-over')};
  drop.ondragleave=()=>drop.classList.remove('drag-over');
  drop.ondrop=async e=>{e.preventDefault();drop.classList.remove('drag-over');if(!await handleTransfer(e.dataTransfer))showToast('No supported file was dropped.')};
  drop.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')drop.focus()};
  $('#importPastedTextBtn').onclick=async()=>{
    const text=textarea.value,title=$('#pasteTitle')?.value||'';
    if(!text.trim()){showToast('Paste some manuscript text first.');textarea.focus();return}
    modal.close();await importPastedText(text,title);
  };
  requestAnimationFrame(()=>textarea.focus());
}
async function importFile(file){
  if(!file)return;
  let paragraphs,parsedChapters=null,sources=null,importDiagnostics=null;
  try{
    const name=file.name.toLowerCase();
    if(name.endsWith('.docx'))paragraphs=await parseDocx(file);
    else if(name.endsWith('.epub')){const parsed=await parseEpub(file);paragraphs=parsed.paragraphs;parsedChapters=parsed.chapters}
    else if(name.endsWith('.pdf')){
      const parsed=await parsePdf(file);paragraphs=parsed.paragraphs;sources=parsed.sources;importDiagnostics=parsed.diagnostics;
    }
    else if(name.endsWith('.odt'))paragraphs=await parseOdt(file);
    else if(name.endsWith('.html')||name.endsWith('.htm'))paragraphs=await parseHtml(file);
    else if(name.endsWith('.md')||name.endsWith('.markdown'))paragraphs=await parseMarkdown(file);
    else if(name.endsWith('.txt'))paragraphs=(await file.text()).replace(/\r/g,'').split(/\n\s*\n|\n/).map(x=>x.trim()).filter(Boolean);
    else throw new Error('That file type is not supported yet.');
    if(!paragraphs?.length)throw new Error('No manuscript text was found.');
    let title=file.name.replace(/\.(docx|epub|pdf|odt|html?|md|markdown|txt)$/i,'').replace(/[_-]+/g,' ').trim();
    const firstUseful=paragraphs.find(p=>p.length>3&&!/^chapter\b/i.test(p));
    if(/the plus[ -]one problem/i.test(title)||/^the plus[ -]one problem/i.test(firstUseful||''))title='The Plus-One Problem';
    const chapters=parsedChapters||splitChapters(paragraphs,sources);
    const now=new Date().toISOString();
    const book={id:uid(),title,fileName:file.name,createdAt:now,updatedAt:now,chapters,progress:{chapterIndex:0,paragraphIndex:0,charOffset:0,wordEnd:0,completed:false},version:'Imported manuscript',importDiagnostics};
    await idbPut('books',book);state.bookId=book.id;state.chapterIndex=0;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;
    savePrefs({lastBookId:book.id});showToast(`Imported ${book.chapters.length} chapter${book.chapters.length===1?'':'s'}`);
    await navigate('reader');
    if(importDiagnostics)showImportReport(book);
  }catch(e){
    if(modal.open){modal.onclose=null;modal.close()}
    showToast(e.message||'Could not import manuscript');
  }
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

    if(data.preferences&&typeof data.preferences==='object')localStorage.setItem(PREF,JSON.stringify(data.preferences));
    const p=prefs();
    state.bookId=(p.lastBookId&&bookIds.has(p.lastBookId))?p.lastBookId:(data.books[0]?.id||null);
    if(state.bookId){const book=await idbGet('books',state.bookId);state.chapterIndex=book?.progress?.chapterIndex||0;state.selectedParagraph=book?.progress?.paragraphIndex||0;state.selectedCharOffset=book?.progress?.charOffset||0;state.selectedWordEnd=book?.progress?.wordEnd||0}
    showToast('Storyline backup restored');
    await navigate('library');
  }catch(e){showToast(e.message||'Backup could not be restored')}
}
function handoffLandingCardHtml(book){
  const h=state.pendingHandoffContext;
  if(!h||h.bookId!==book?.id)return '';
  return `<section id="handoffLandingCard" class="handoff-landing card">
    <div><div class="eyebrow">Handoff received</div><h3>${escapeHtml(h.adjusted?'Passage relocated':'You are in the right place')}</h3>
    <p class="meta">${escapeHtml(h.location||'')}</p>
    ${h.excerpt?`<blockquote>${escapeHtml(h.excerpt)}</blockquote>`:''}
    ${h.adjusted?'<p class="meta">This device has a different revision, so Storyline matched the passage using its surrounding text.</p>':''}</div>
    <button id="dismissHandoffLanding" class="ghost tiny" type="button">Dismiss</button>
  </section>`;
}
function openHandoffSender(book){
  stopHandoffScanner();
  const packet=makeHandoffPacket(book),code=encodeHandoffPacket(packet),webUrl=handoffWebUrl(code);
  const pos=handoffPosition(book),locationText=handoffDisplayLocation(book,{chapterIndex:pos.chapterIndex,paragraphIndex:pos.paragraphIndex});
  modalForm.innerHTML=`<h3>Handoff to another device</h3>
    <p class="sub">Scan this with the other device. The code contains only this book's identity, reading position and a short passage excerpt.</p>
    <div id="handoffQr" class="handoff-qr" aria-label="Storyline handoff QR code"></div>
    <div class="handoff-location"><strong>${escapeHtml(locationText)}</strong><span class="meta">Word position ${pos.charOffset+1}</span></div>
    <div class="excerpt">${escapeHtml(packet.excerpt||'')}</div>
    <div class="row handoff-actions"><button type="button" id="copyHandoffLink" class="ghost">Copy handoff link</button><button type="button" id="shareHandoffLink" class="ghost ${navigator.share?'':'hidden'}">Share</button><button value="default" class="button">Done</button></div>
    <p class="meta">The QR opens Storyline directly when scanned by a normal camera app. You can also scan it from inside Storyline.</p>`;
  if(!modal.open)modal.showModal();
  requestAnimationFrame(()=>{
    const qr=$('#handoffQr');
    if(qr&&window.QRCode){
      try{new QRCode(qr,{text:webUrl,width:288,height:288,colorDark:'#111111',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.L})}
      catch{qr.innerHTML='<div class="empty">QR generation failed. Use Copy handoff link instead.</div>'}
    }else if(qr)qr.innerHTML='<div class="empty">QR generator is unavailable. Use Copy handoff link instead.</div>';
  });
  $('#copyHandoffLink').onclick=()=>copyTextReliable(webUrl,'Handoff link copied');
  const share=$('#shareHandoffLink');if(share)share.onclick=async()=>{
    try{await navigator.share({title:`Storyline handoff — ${book.title}`,text:'Open this Storyline reading position:',url:webUrl})}
    catch(e){if(e?.name!=='AbortError')copyTextReliable(webUrl,'Handoff link copied')}
  };
}
async function showHandoffConfirmation(packet){
  stopHandoffScanner();
  const match=await matchHandoffBook(packet);
  if(!match.book){
    modalForm.innerHTML=`<h3>Manuscript not on this device</h3>
      <p class="sub"><strong>${escapeHtml(packet.title||'This manuscript')}</strong> is not in this Storyline library yet.</p>
      <div class="excerpt">${escapeHtml(packet.excerpt||'')}</div>
      <p>Import the same manuscript (or another revision of it), then scan or paste the handoff again.</p>
      <div class="row between"><button type="button" id="handoffTryAgain" class="ghost">Try another code</button><button type="button" id="handoffImportBook" class="button">Import manuscript</button></div>`;
    if(!modal.open)modal.showModal();
    $('#handoffTryAgain').onclick=()=>openHandoffReceiver();
    $('#handoffImportBook').onclick=()=>{modal.close();fileInput.click()};
    return;
  }
  const pos=resolveHandoffPosition(match.book,packet,match.exactEdition);
  const locationText=handoffDisplayLocation(match.book,pos);
  const matchText=match.exactEdition?'Exact manuscript match':match.matchKind==='book'?'Same book · different revision':'Matched by manuscript title';
  modalForm.innerHTML=`<h3>Receive handoff?</h3>
    <div class="source-chip">${escapeHtml(match.book.title)} · ${escapeHtml(matchText)}</div>
    <h4>${escapeHtml(locationText)}</h4>
    <div class="excerpt">${escapeHtml(packet.excerpt||'')}</div>
    ${pos.adjusted?'<p class="sub">The manuscript appears to have changed. Storyline matched the surrounding passage and will use the best verified location.</p>':''}
    ${match.multiple?'<p class="meta">More than one copy matched. Storyline selected the most recently read copy.</p>':''}
    <div class="row between"><button type="button" id="handoffCancel" class="ghost">Cancel</button><button type="button" id="handoffJump" class="button">Jump there</button></div>`;
  if(!modal.open)modal.showModal();
  $('#handoffCancel').onclick=()=>modal.close();
  $('#handoffJump').onclick=()=>applyHandoffJump(match.book,packet,pos,match);
}
async function applyHandoffJump(book,packet,pos,match){
  stopHandoffScanner();stopAllSpeech();
  state.bookId=book.id;state.chapterIndex=pos.chapterIndex;state.selectedParagraph=pos.paragraphIndex;
  state.selectedCharOffset=Math.max(0,pos.start||0);state.selectedWordEnd=Math.max(state.selectedCharOffset,pos.end||state.selectedCharOffset);
  state.recapBookId=null;state.liveCharOffset=null;
  state.pendingPassageReference={chapterIndex:pos.chapterIndex,paragraphIndex:pos.paragraphIndex,start:state.selectedCharOffset,end:state.selectedWordEnd,moved:false,unverified:false};
  state.pendingHandoffContext={bookId:book.id,excerpt:String(packet.excerpt||'').slice(0,180),adjusted:!!pos.adjusted,location:handoffDisplayLocation(book,pos),matchKind:match.matchKind};
  savePrefs({lastBookId:book.id});
  await saveProgress(book);
  if(modal.open)modal.close();
  await navigate('reader');
  showToast(pos.adjusted?'Position adjusted. The manuscript changed since the handoff was made.':'Handoff received');
}
async function processHandoffValue(value,{quietInvalid=false}={}){
  const packet=decodeHandoffPacket(value);
  if(!packet){if(!quietInvalid)showToast("This code isn't a Storyline handoff.");return false}
  await showHandoffConfirmation(packet);return true;
}
async function decodeHandoffImage(file){
  if(!file)return;
  try{
    let source=null,revoke='';
    if(window.createImageBitmap)source=await createImageBitmap(file);
    else{
      const url=URL.createObjectURL(file);revoke=url;
      source=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url});
    }
    const w=source.width||source.naturalWidth,h=source.height||source.naturalHeight;
    const scale=Math.min(1,1200/Math.max(w,h)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);
    let raw='';
    if('BarcodeDetector' in window){
      try{
        const detector=new BarcodeDetector({formats:['qr_code']});
        const hits=await detector.detect(canvas);raw=hits?.[0]?.rawValue||'';
      }catch{}
    }
    if(!raw&&window.jsQR){
      const image=ctx.getImageData(0,0,canvas.width,canvas.height),hit=jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});
      raw=hit?.data||'';
    }
    try{source.close?.()}catch{};if(revoke)URL.revokeObjectURL(revoke);
    if(!raw){showToast('No QR code was found in that image.');return}
    await processHandoffValue(raw);
  }catch{showToast('Storyline could not read that QR image.')}
}
async function startHandoffCameraScan(){
  stopHandoffScanner();
  const video=$('#handoffVideo'),status=$('#handoffScanStatus');
  if(!video||!navigator.mediaDevices?.getUserMedia){if(status)status.textContent='Camera scanning is not available here. Use a QR image or paste the handoff link.';return}
  let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  }catch{
    if(status)status.textContent='Camera access was not available. You can still choose a QR image or paste the handoff link.';
    return;
  }
  video.srcObject=stream;video.classList.remove('hidden');video.setAttribute('playsinline','');
  try{await video.play()}catch{}
  if(status)status.textContent='Point the camera at a Storyline handoff QR code.';
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  let stopped=false,raf=0,lastBad=0,nativeDetector=null;
  if('BarcodeDetector' in window){try{nativeDetector=new BarcodeDetector({formats:['qr_code']})}catch{}}
  const stop=()=>{
    if(stopped)return;stopped=true;if(raf)cancelAnimationFrame(raf);
    try{stream?.getTracks().forEach(t=>t.stop())}catch{}
    if(video)video.srcObject=null;
  };
  state.handoffScanStop=stop;
  const scan=async()=>{
    if(stopped)return;
    if(video.readyState>=2&&video.videoWidth&&video.videoHeight){
      const scale=Math.min(1,720/video.videoWidth);
      canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      let raw='';
      if(nativeDetector){
        try{const hits=await nativeDetector.detect(canvas);raw=hits?.[0]?.rawValue||''}catch{nativeDetector=null}
      }
      if(!raw&&window.jsQR){
        try{const image=ctx.getImageData(0,0,canvas.width,canvas.height),hit=jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});raw=hit?.data||''}catch{}
      }
      if(raw){
        const packet=decodeHandoffPacket(raw);
        if(packet){stop();await showHandoffConfirmation(packet);return}
        if(Date.now()-lastBad>1800){lastBad=Date.now();showToast("That QR isn't a Storyline handoff.")}
      }
    }
    if(!stopped)raf=requestAnimationFrame(scan);
  };
  raf=requestAnimationFrame(scan);
}
function openHandoffReceiver(initialValue=''){
  stopHandoffScanner();
  modalForm.innerHTML=`<h3>Receive a handoff</h3>
    <p class="sub">Scan from the camera, choose a QR screenshot/photo, or paste a Storyline handoff link. Decoding stays on this device.</p>
    <video id="handoffVideo" class="handoff-video hidden" muted playsinline></video>
    <div id="handoffScanStatus" class="meta">Choose how you want to receive the position.</div>
    <div class="handoff-receive-actions"><button type="button" id="handoffCameraBtn" class="button">Scan with camera</button><button type="button" id="handoffImageBtn" class="ghost">Choose QR image</button><input id="handoffImageInput" type="file" accept="image/*" hidden /></div>
    <label class="handoff-paste"><span class="meta">Or paste the handoff link/code</span><textarea id="handoffPaste" placeholder="Paste Storyline handoff here…">${escapeHtml(initialValue)}</textarea></label>
    <div class="row between"><button value="cancel" class="ghost">Close</button><button type="button" id="handoffPasteBtn" class="button">Open handoff</button></div>`;
  if(!modal.open)modal.showModal();
  modal.addEventListener('close',stopHandoffScanner,{once:true});
  $('#handoffCameraBtn').onclick=startHandoffCameraScan;
  $('#handoffImageBtn').onclick=()=>$('#handoffImageInput').click();
  $('#handoffImageInput').onchange=e=>{const file=e.target.files?.[0];e.target.value='';decodeHandoffImage(file)};
  $('#handoffPasteBtn').onclick=()=>processHandoffValue($('#handoffPaste').value);
  if(initialValue)requestAnimationFrame(()=>processHandoffValue(initialValue));
}
async function processHandoffFromLocation(){
  const code=extractHandoffCode(location.href);if(!code)return false;
  try{
    const clean=location.pathname+location.search;
    history.replaceState(null,'',clean);
  }catch{}
  return processHandoffValue(code);
}
function revisionTypeMeta(type){
  return type==='voice'?['🎙','VOICE NOTE']:type==='continuity'?['⚑','CONTINUITY']:type==='bookmark'?['⌑','BOOKMARK']:type==='question'?['?','ASK CHATGPT']:['📝','NOTE'];
}
function revisionDate(iso){
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}
function revisionChecklistMarkdown(book,items,{preview=false}={}){
  const date=new Date().toISOString().slice(0,10);
  const matched=[],unmatched=[];
  for(const item of items){
    const resolved=resolvePassageAnchor(book,item);
    const row={item,resolved};
    if(resolved?.unverified)unmatched.push(row);else matched.push(row);
  }
  matched.sort((a,b)=>(a.resolved.chapterIndex-b.resolved.chapterIndex)||(a.resolved.paragraphIndex-b.resolved.paragraphIndex)||new Date(a.item.createdAt)-new Date(b.item.createdAt));
  unmatched.sort((a,b)=>new Date(a.item.createdAt)-new Date(b.item.createdAt));
  const lines=[`# Revision checklist — ${book.title} (${date}, ${items.length} item${items.length===1?'':'s'})`,''];
  let lastChapter=-1;
  for(const row of matched){
    const {item,resolved}=row,ch=book.chapters[resolved.chapterIndex];
    if(resolved.chapterIndex!==lastChapter){
      if(lastChapter!==-1)lines.push('');
      lines.push(`## ${chapterLabel(ch,book)}`);lastChapter=resolved.chapterIndex;
    }
    const [icon,label]=revisionTypeMeta(item.type);
    const passage=excerpt(item.anchor?.selectedText||item.excerpt||'',140).replace(/\s+/g,' ');
    let note=String(item.note||'').trim();
    if(preview&&note.length>300)note=note.slice(0,299)+'…';
    const audio=item.type==='voice'&&item.durationSec?` · ${formatDuration(item.durationSec)}`:'';
    const detail=note?` — ${note}`:'';
    lines.push(`- [ ] ${icon} ${label} · ¶${resolved.paragraphIndex+1}${audio} · "${passage}"${detail} (added ${revisionDate(item.createdAt)})`);
  }
  if(unmatched.length){
    lines.push('','## Unmatched items');
    for(const {item} of unmatched){
      const [icon,label]=revisionTypeMeta(item.type),passage=excerpt(item.anchor?.selectedText||item.excerpt||'',140).replace(/\s+/g,' ');
      let note=String(item.note||'').trim();if(preview&&note.length>300)note=note.slice(0,299)+'…';
      lines.push(`- [ ] ${icon} ${label} · "${passage}"${note?` — ${note}`:''} (added ${revisionDate(item.createdAt)})`);
    }
  }
  return lines.join('\n');
}
function downloadTextFile(filename,text,type='text/plain'){
  const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function openRevisionChecklist(book){
  const all=(await idbGetAll('items')).filter(i=>i.bookId===book.id&&['question','continuity','note','bookmark','voice'].includes(i.type));
  if(!all.length){showToast('No notes or flags in this book yet.');return}
  let filter='pending';
  const filtered=()=>filter==='all'?all:filter==='actioned'?all.filter(i=>i.status==='done'):all.filter(i=>i.status!=='done');
  const render=()=>{
    const items=filtered(),preview=revisionChecklistMarkdown(book,items,{preview:true});
    modalForm.innerHTML=`<h3>Revision checklist</h3><div class="row between"><span class="meta">${escapeHtml(book.title)}</span><select id="revisionFilter" class="select"><option value="pending" ${filter==='pending'?'selected':''}>Pending only</option><option value="actioned" ${filter==='actioned'?'selected':''}>Actioned only</option><option value="all" ${filter==='all'?'selected':''}>Everything</option></select></div>
      <textarea id="revisionChecklistPreview" class="revision-checklist-preview" readonly>${escapeHtml(preview)}</textarea>
      <div class="row between"><button value="cancel" class="ghost">Close</button><div class="row"><button type="button" id="copyRevisionChecklist" class="ghost">Copy</button><button type="button" id="downloadRevisionChecklist" class="button">Download .md</button></div></div>`;
    if(!modal.open)modal.showModal();
    $('#revisionFilter').onchange=e=>{filter=e.target.value;render()};
    $('#copyRevisionChecklist').onclick=()=>{const items=filtered();if(!items.length){showToast('No revision items in this view.');return}copyTextReliable(revisionChecklistMarkdown(book,items),'Revision checklist copied')};
    $('#downloadRevisionChecklist').onclick=()=>{const items=filtered();if(!items.length){showToast('No revision items in this view.');return}
      const safe=book.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'manuscript';
      downloadTextFile(`${safe}-revision-checklist-${new Date().toISOString().slice(0,10)}.md`,revisionChecklistMarkdown(book,items),'text/markdown');
      showToast('Revision checklist downloaded');
    };
  };
  render();
}
async function renderLibrary(){
  const books=(await idbGetAll('books')).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  const items=await idbGetAll('items');
  view.innerHTML=`
    <section class="hero"><div class="eyebrow">Your private listening desk</div><h1>Read with your ears.<br>Revise with receipts.</h1><p class="sub">Your manuscript stays in this browser. Storyline remembers where you stopped and keeps every note tied to its exact passage.</p><div class="row hero-actions"><button id="receiveHandoffBtn" class="ghost">Receive handoff</button></div></section>
    <section id="importZone" class="import-zone" tabindex="0"><strong>${books.length?'Add another manuscript':'Bring in a manuscript'}</strong><p class="sub">DOCX, EPUB, PDF, ODT, Markdown, HTML, TXT, or pasted text. Chapter headings are detected automatically.</p><div class="row import-actions"><button id="importBtn" class="button">Choose manuscript</button><button id="pasteImportBtn" class="ghost">Paste text or file</button></div><div class="privacy">You can also drag/drop or paste a copied manuscript file here. Everything stays local to this browser.</div></section>
    <section class="backup-card card"><div><div class="eyebrow">Data safety</div><h2>Backup & restore</h2><p class="sub">Export manuscripts, reading positions, Queue and Actioned items, preferences, and saved voice-note audio.</p></div><div class="row backup-actions"><button id="exportBackupBtn" class="ghost">Export backup</button><button id="restoreBackupBtn" class="ghost">Restore backup</button><input id="restoreBackupInput" type="file" accept="application/json,.json" hidden /></div></section>
    ${books.length?`<h2 class="section-title">My manuscripts</h2><div class="grid books">${books.map(b=>bookCard(b,items)).join('')}</div>`:`<div class="empty">Your library is waiting for its first book.</div>`}
  `;
  $('#importBtn').onclick=()=>fileInput.click();
  $('#pasteImportBtn').onclick=()=>openPasteImport();
  const receiveHandoff=$('#receiveHandoffBtn');if(receiveHandoff)receiveHandoff.onclick=()=>openHandoffReceiver();
  const importZone=$('#importZone');
  importZone.onpaste=async e=>{
    if(e.target.closest('input,textarea'))return;
    e.preventDefault();
    const file=pastedFileFromTransfer(e.clipboardData);
    if(file){await importFile(file);return}
    const text=e.clipboardData?.getData?.('text/plain')||'';
    if(text)openPasteImport(text);else showToast('No manuscript text or file was found on the clipboard.');
  };
  importZone.ondragover=e=>{e.preventDefault();importZone.classList.add('drag-over')};
  importZone.ondragleave=()=>importZone.classList.remove('drag-over');
  importZone.ondrop=async e=>{e.preventDefault();importZone.classList.remove('drag-over');const file=pastedFileFromTransfer(e.dataTransfer);if(file)await importFile(file);else showToast('Drop a supported manuscript file here.')};
  $('#exportBackupBtn').onclick=exportBackup;
  $('#restoreBackupBtn').onclick=()=>$('#restoreBackupInput').click();
  $('#restoreBackupInput').onchange=e=>{const file=e.target.files?.[0];e.target.value='';restoreBackup(file)};
  $$('.book-card').forEach(c=>c.onclick=async e=>{ if(e.target.closest('[data-delete],[data-export-revisions]')) return; state.bookId=c.dataset.id; state.recapBookId=state.bookId; state.selectedReaderPhrase=''; savePrefs({lastBookId:state.bookId}); const b=await idbGet('books',state.bookId); state.chapterIndex=b.progress?.chapterIndex||0; state.selectedParagraph=b.progress?.paragraphIndex||0; state.selectedCharOffset=b.progress?.charOffset||0; state.selectedWordEnd=b.progress?.wordEnd||0; navigate('reader'); });
  $$('[data-delete]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=btn.dataset.delete; if(confirm('Remove this manuscript and its saved notes from this device?')){await idbDelete('books',id); const all=await idbGetAll('items'); for(const i of all.filter(x=>x.bookId===id)) await idbDelete('items',i.id); if(state.bookId===id) state.bookId=null; renderLibrary(); updateQueueBadge();}});
  $$('[data-export-revisions]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const book=await idbGet('books',btn.dataset.exportRevisions);if(book)openRevisionChecklist(book)});
}
function chapterLabel(ch,book){ return (ch?.synthetic||ch?.title==='Beginning'||ch?.title==='Front matter')?(book?.title||'Manuscript'):(ch?.title||'Manuscript'); }
function readerChapterTitle(ch){ return (ch?.synthetic||ch?.title==='Beginning'||ch?.title==='Front matter')?'':(ch?.title||''); }
function searchBook(book,query,limit=400){
  const q=String(query||'').trim();if(!q)return {query:'',results:[],truncated:false};
  const needle=q.toLocaleLowerCase();
  const results=[];let truncated=false;
  outer:for(let ci=0;ci<book.chapters.length;ci++){
    const ch=book.chapters[ci];
    for(let pi=0;pi<ch.paragraphs.length;pi++){
      const text=String(ch.paragraphs[pi]||''),hay=text.toLocaleLowerCase();
      let from=0;
      while(from<=hay.length){
        const start=hay.indexOf(needle,from);if(start<0)break;
        const end=start+q.length;
        const before=text.slice(Math.max(0,start-90),start);
        const match=text.slice(start,end);
        const after=text.slice(end,Math.min(text.length,end+90));
        results.push({chapterIndex:ci,paragraphIndex:pi,start,end,chapterTitle:chapterLabel(ch,book),before,match,after});
        if(results.length>=limit){truncated=true;break outer}
        from=start+Math.max(1,q.length);
      }
    }
  }
  return {query:q,results,truncated};
}
function searchResultHtml(result,index){
  return `<button type="button" class="reader-search-result" data-search-result="${index}">
    <span class="reader-search-location">${escapeHtml(result.chapterTitle)} · paragraph ${result.paragraphIndex+1}</span>
    <span class="reader-search-snippet">${result.before?'…'+escapeHtml(result.before):''}<mark>${escapeHtml(result.match)}</mark>${result.after?escapeHtml(result.after)+'…':''}</span>
    <span class="reader-search-actions"><span>Go to match</span><span data-search-play="${index}">▶ Play from here</span></span>
  </button>`;
}
function renderReaderSearchResults(book,query){
  const panel=$('#readerSearchResults'),status=$('#readerSearchStatus');if(!panel||!status)return;
  const found=searchBook(book,query);
  state.readerSearchQuery=found.query;
  if(!found.query){panel.innerHTML='';panel.classList.add('hidden');status.textContent='';return}
  status.textContent=found.results.length?(found.truncated?`Showing first ${found.results.length} matches`:`${found.results.length} match${found.results.length===1?'':'es'}`):'No matches';
  panel.innerHTML=found.results.length?found.results.map(searchResultHtml).join(''):'<div class="reader-search-empty">No matches in this manuscript.</div>';
  panel.classList.remove('hidden');
  panel.dataset.searchResults=JSON.stringify(found.results);
}
function wordCount(text=''){return (String(text).trim().match(/\S+/g)||[]).length}
function chapterWordCount(ch){return (ch?.paragraphs||[]).reduce((n,p)=>n+wordCount(p),0)}
function readingWpm(){return 170*Math.max(.1,Number(prefs().rate||1.05))}
function readingMinutesLabel(words){
  const minutes=words/readingWpm();
  if(minutes<1)return '<1 min';
  return '~'+Math.max(1,Math.round(minutes))+' min';
}
function remainingChapterWords(ch,paragraphIndex=0,charOffset=0){
  if(!ch?.paragraphs?.length)return 0;
  let words=0;
  for(let i=paragraphIndex;i<ch.paragraphs.length;i++){
    const text=String(ch.paragraphs[i]||'');
    words+=wordCount(i===paragraphIndex?text.slice(Math.max(0,charOffset)):text);
  }
  return words;
}
function updateReadingTimeMeta(book){
  const ch=book?.chapters?.[state.chapterIndex],el=$('#timeLeftLabel');
  if(!ch||!el)return;
  el.textContent=readingMinutesLabel(remainingChapterWords(ch,state.selectedParagraph,state.selectedCharOffset||0))+' left in chapter';
}
function refreshChapterTimeOptions(book){
  const sel=$('#chapterSelect');if(!sel||!book?.chapters)return;
  [...sel.options].forEach((opt,i)=>{const ch=book.chapters[i];if(ch)opt.textContent=`${chapterLabel(ch,book)} · ${readingMinutesLabel(chapterWordCount(ch))}`});
}
function relativeDateText(iso){
  const t=Date.parse(iso||'');if(!Number.isFinite(t))return '';
  const diff=Date.now()-t,day=86400000;
  if(diff<day*2)return 'yesterday';
  const days=Math.floor(diff/day);
  if(days<14)return days+' days ago';
  const weeks=Math.floor(days/7);if(weeks<8)return weeks+' weeks ago';
  const months=Math.max(1,Math.floor(days/30));return months+' months ago';
}
function recapSentences(book,progress,limit=3){
  const ci=Math.max(0,Math.min(progress?.chapterIndex||0,book.chapters.length-1));
  const ch=book.chapters[ci];if(!ch)return [];
  const pi=Math.max(0,Math.min(progress?.paragraphIndex||0,ch.paragraphs.length-1));
  const snippets=[];
  const collect=text=>{
    const parts=sentenceSegments(text,0).map(x=>x.text).filter(Boolean);
    for(let i=parts.length-1;i>=0&&snippets.length<limit;i--)snippets.unshift(parts[i]);
  };
  const current=String(ch.paragraphs[pi]||''),offset=Math.max(0,progress?.charOffset||0);
  const completedCurrent=sentenceSegments(current,0).filter(s=>s.end<=offset).map(s=>s.text);
  for(let i=completedCurrent.length-1;i>=0&&snippets.length<limit;i--)snippets.unshift(completedCurrent[i]);
  for(let p=pi-1;p>=0&&snippets.length<limit;p--)collect(ch.paragraphs[p]||'');
  if(snippets.length<limit&&ci>0){
    const prev=book.chapters[ci-1];
    for(let p=prev.paragraphs.length-1;p>=0&&snippets.length<limit;p--)collect(prev.paragraphs[p]||'');
  }
  return snippets.slice(-limit);
}
function shouldShowRecap(book){
  const p=book?.progress;if(!p||p.completed||state.recapBookId!==book.id)return false;
  const moved=(p.chapterIndex||0)>0||(p.paragraphIndex||0)>0||(p.charOffset||0)>0;
  const t=Date.parse(p.updatedAt||book.updatedAt||'');
  return moved&&Number.isFinite(t)&&(Date.now()-t)>=86400000;
}
function recapCardHtml(book){
  if(!shouldShowRecap(book))return '';
  const p=book.progress,ch=book.chapters[p.chapterIndex||0],sentences=recapSentences(book,p);
  return `<section id="recapCard" class="recap-card card">
    <div><div class="eyebrow">Pick up the thread</div><h3>Last read ${escapeHtml(relativeDateText(p.updatedAt||book.updatedAt))}</h3>
    <p class="meta">${escapeHtml(chapterLabel(ch,book))} · paragraph ${(p.paragraphIndex||0)+1} of ${ch?.paragraphs?.length||0}</p>
    ${sentences.length?`<blockquote>${escapeHtml(sentences.join(' '))}</blockquote>`:''}</div>
    <div class="row recap-actions"><button id="recapResume" class="button">Resume</button><button id="recapChapterStart" class="ghost">Chapter start</button><button id="recapDismiss" class="ghost">Dismiss</button></div>
  </section>`;
}
function sourceRefFor(book,chapterIndex,paragraphIndex){
  return book?.chapters?.[chapterIndex]?.sourceRefs?.[paragraphIndex]||null;
}
function readerPositionLabel(book,chapterIndex,paragraphIndex,total,extra=''){
  const source=sourceRefFor(book,chapterIndex,paragraphIndex),sourceText=pdfSourceLabel(source);
  return [`Paragraph ${paragraphIndex+1} of ${total}`,sourceText,extra].filter(Boolean).join(' · ');
}
function bookCard(b,items){ const total=b.chapters.reduce((n,c)=>n+c.paragraphs.length,0); let before=0; for(let i=0;i<(b.progress?.chapterIndex||0);i++) before+=b.chapters[i]?.paragraphs.length||0; before+=b.progress?.paragraphIndex||0; const pct=b.progress?.completed===true?100:Math.max(0,Math.min(100,Math.round((before/Math.max(total,1))*100))); const count=items.filter(i=>i.bookId===b.id&&['note','question','continuity','bookmark','voice'].includes(i.type)).length;
  const totalWords=b.chapters.reduce((n,ch)=>n+chapterWordCount(ch),0);
  return `<article class="card book-card" data-id="${b.id}"><div><div class="eyebrow">${escapeHtml(b.version||'Manuscript')}</div><div class="book-title">${escapeHtml(b.title)}</div><p class="meta">${b.chapters.length} chapter${b.chapters.length===1?'':'s'} · ${readingMinutesLabel(totalWords)} · ${count} revision item${count===1?'':'s'}</p></div><div class="stack"><div class="row between"><span class="meta">${pct}% listened</span><button data-delete="${b.id}" class="ghost tiny">Remove</button></div><div class="progress"><i style="width:${pct}%"></i></div><div class="row book-actions"><button class="button">Continue reading</button><button data-export-revisions="${b.id}" class="ghost tiny">Revision checklist</button></div></div></article>`;
}

async function renderReader(){
  const book=await idbGet('books',state.bookId); if(!book){navigate('library');return}
  state.readerBook=book;
  state.chapterIndex=Math.max(0,Math.min(state.chapterIndex,book.chapters.length-1)); const ch=book.chapters[state.chapterIndex]; state.selectedParagraph=Math.max(0,Math.min(state.selectedParagraph,ch.paragraphs.length-1));
  const p=prefs();
  view.innerHTML=`
    <section class="reader-header"><div class="row between"><div><div class="eyebrow">${escapeHtml(book.title)}</div>${readerChapterTitle(ch)?`<h2 class="reader-title">${escapeHtml(readerChapterTitle(ch))}</h2>`:''}</div><button id="backLibrary" class="ghost tiny">Library</button></div>
    <select id="chapterSelect" class="chapter-select">${book.chapters.map((c,i)=>`<option value="${i}" ${i===state.chapterIndex?'selected':''}>${escapeHtml(chapterLabel(c,book))} · ${readingMinutesLabel(chapterWordCount(c))}</option>`).join('')}</select>
    ${recapCardHtml(book)}
    ${handoffLandingCardHtml(book)}
    <div class="reader-search">
      <div class="reader-search-row"><input id="readerSearchInput" class="select reader-search-input" type="search" value="${escapeHtml(state.readerSearchQuery)}" placeholder="Search this manuscript…" aria-label="Search this manuscript" /><button id="readerSearchBtn" class="ghost">Search</button><button id="readerSearchClear" class="ghost tiny ${state.readerSearchQuery?'':'hidden'}" aria-label="Clear search">Clear</button></div>
      <div class="row between"><span id="readerSearchStatus" class="meta"></span><span class="meta">Word or phrase · all chapters</span></div>
      <div id="readerSearchResults" class="reader-search-results hidden"></div>
    </div></section>
    <article id="readingPage" class="reading-page" aria-label="Manuscript text">${ch.paragraphs.map((t,i)=>`<p data-p="${i}" class="${i===state.selectedParagraph?'selected':''}">${escapeHtml(t)}</p>`).join('')}</article>
    <button id="selectionPronunciationBtn" class="ghost tiny selection-pronunciation hidden" type="button">Say selected text as…</button>
    <section class="player compact-player">
      <div class="player-main compact-player-main">
        <div class="transport-buttons">
          <button id="prevBtn" class="ghost transport-skip" aria-label="Previous paragraph">‹</button>
          <button id="playBtn" class="button play" aria-label="Play">▶</button>
          <button id="nextBtn" class="ghost transport-skip" aria-label="Next paragraph">›</button>
          <button id="replayBtn" class="ghost transport-replay" aria-label="Replay current sentence" disabled>↺</button>
          <button id="repeatBtn" class="ghost transport-replay ${p.repeatParagraph?'active':''}" aria-label="Repeat paragraph" aria-pressed="${p.repeatParagraph?'true':'false'}">⟳</button>
        </div>
        <div class="transport-progress"><div class="row between"><span id="positionLabel" class="meta">${escapeHtml(readerPositionLabel(book,state.chapterIndex,state.selectedParagraph,ch.paragraphs.length))}</span><span id="timeLeftLabel" class="meta">${readingMinutesLabel(remainingChapterWords(ch,state.selectedParagraph,state.selectedCharOffset||0))} left in chapter</span><span id="speedLabel" class="meta">${Number(p.rate||1.05).toFixed(2)}×</span></div><input id="positionRange" class="range" type="range" min="0" max="${Math.max(ch.paragraphs.length-1,0)}" value="${state.selectedParagraph}" /></div>
      </div>
      <div class="compact-status"><span id="voiceStatus" class="reading-status">Loading device voices…</span><button id="resumeFollowBtn" class="ghost tiny hidden">↧ Resume follow</button></div>
      <details id="voiceOptions" class="voice-options">
        <summary><span>Voice & speed</span><span id="voiceSummary" class="meta">Samantha · ${(p.readingStyle||'natural')==='standard'?'Standard':'Natural'} · ${Number(p.rate||1.05).toFixed(2)}×</span></summary>
        <div class="voice-options-panel">
          <select id="voiceSelect" class="select"><option>Loading Samantha…</option></select>
          <label class="voice-style-setting"><span class="meta">Reading style</span><select id="readingStyleSelect" class="select"><option value="natural" ${(p.readingStyle||'natural')==='natural'?'selected':''}>Natural · flowing</option><option value="standard" ${p.readingStyle==='standard'?'selected':''}>Standard · sentence by sentence</option></select><small class="meta">Natural keeps Samantha speaking across a few sentences for smoother phrasing.</small></label>
          <label class="speed-box"><span class="meta">Speed</span><select id="rateSelect" class="select" title="Reading speed">${rateOptions(p.rate||1.05)}</select><small class="meta">Changes take effect immediately while reading.</small></label>
          <div class="dialogue-settings">
            <label class="chapter-advance-toggle"><input id="dialogueToggle" type="checkbox" ${p.dialogueEnabled?'checked':''} /><span><strong>Dialogue voice</strong><small>Use a shifted voice for quoted dialogue.</small></span></label>
            <div id="dialogueControls" class="dialogue-controls ${p.dialogueEnabled?'':'hidden'}">
              <label><span class="meta">Dialogue Samantha</span><select id="dialogueVoiceSelect" class="select"><option value="">Same Samantha</option></select></label>
              <label><span class="meta">Pitch</span><select id="dialoguePitchSelect" class="select">${dialoguePitchOptions(p.dialoguePitch??1.15)}</select></label>
              <label><span class="meta">Rate offset</span><select id="dialogueRateSelect" class="select">${dialogueRateOptions(p.dialogueRateOffset??0)}</select></label>
              <div class="meta dialogue-note">Quoted dialogue only in this version. Em-dash and screenplay-style dialogue stay in the narration voice.</div>
            </div>
          </div>
          <button id="testVoiceBtn" class="ghost tiny">Preview Samantha here</button>
          <div id="voiceAvailabilityNote" class="meta voice-availability-note"></div>
          <div class="sleep-box"><span class="meta">Sleep timer</span><select id="sleepTimerSelect" class="select"><option value="0">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select><span id="sleepTimerStatus" class="meta">Sleep timer off</span></div>
          <label class="chapter-advance-toggle"><input id="autoAdvanceToggle" type="checkbox" ${p.autoAdvance!==false?'checked':''} /><span><strong>Continue to next chapter</strong><small>Keep reading automatically when a chapter ends.</small></span></label>
          <div class="wake-note meta">Screen stays awake while Storyline reads, when supported. Manually locking the device can still pause playback.</div>
        </div>
      </details>
    </section>`;
  wireReader(book,ch); loadVoices(); requestAnimationFrame(()=>{
    if(state.sleepDeadline){const sleep=$('#sleepTimerSelect');if(sleep)sleep.value=String(state.sleepMinutes||0);updateSleepTimerStatus()}
    updateReadingTimeMeta(book);
    const ref=state.pendingPassageReference;
    if(ref&&ref.chapterIndex===state.chapterIndex&&ref.paragraphIndex===state.selectedParagraph){
      markReferenceRange(ref.paragraphIndex,ref.start,ref.end);
      state.pendingPassageReference=null;
      scrollSelected(false);
      if(ref.unverified)showToast('Opened the saved location, but Storyline could not fully verify this reference.');
      else if(ref.moved)showToast('Reference found at its new location.');
    }else{
      if(state.selectedCharOffset>0)markStartWord(state.selectedParagraph,state.selectedCharOffset,state.selectedWordEnd||state.selectedCharOffset);
      scrollSelected(false);
    }
  });
}

function wireReader(book,ch){
  $('#backLibrary').onclick=()=>navigate('library');
  const readingPage=$('#readingPage'),resumeFollow=$('#resumeFollowBtn'),selectionPronunciation=$('#selectionPronunciationBtn');
  const cacheReaderSelection=()=>{setTimeout(()=>{
    const text=selectedReaderText();
    if(text){
      state.selectedReaderPhrase=text;
      if(selectionPronunciation){selectionPronunciation.textContent=`Say “${excerpt(text,34)}” as…`;selectionPronunciation.classList.remove('hidden')}
    }
  },0)};
  readingPage?.addEventListener('mouseup',cacheReaderSelection);
  readingPage?.addEventListener('touchend',cacheReaderSelection,{passive:true});
  if(selectionPronunciation)selectionPronunciation.onclick=()=>pronunciationManager(book,state.selectedReaderPhrase);
  const suspendFollow=()=>{
    if(!state.isSpeaking||state.followNarrationSuspended)return;
    state.followNarrationSuspended=true;updateFollowControl();
  };
  readingPage?.addEventListener('touchmove',suspendFollow,{passive:true});
  readingPage?.addEventListener('wheel',suspendFollow,{passive:true});
  if(resumeFollow)resumeFollow.onclick=()=>resumeNarrationFollow();
  updateFollowControl();
  const searchInput=$('#readerSearchInput'),searchBtn=$('#readerSearchBtn'),searchClear=$('#readerSearchClear');
  const runSearch=()=>{renderReaderSearchResults(book,searchInput?.value||'');searchClear?.classList.toggle('hidden',!String(searchInput?.value||'').trim());wireReaderSearchResults(book)};
  if(searchBtn)searchBtn.onclick=runSearch;
  if(searchInput)searchInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();runSearch()}else if(e.key==='Escape'){e.preventDefault();searchInput.value='';state.readerSearchQuery='';renderReaderSearchResults(book,'');searchClear?.classList.add('hidden')}};
  if(searchClear)searchClear.onclick=()=>{if(searchInput)searchInput.value='';state.readerSearchQuery='';renderReaderSearchResults(book,'');searchClear.classList.add('hidden');searchInput?.focus()};
  if(state.readerSearchQuery){renderReaderSearchResults(book,state.readerSearchQuery);wireReaderSearchResults(book)}

  $('#chapterSelect').onchange=async e=>{ stopAllSpeech(); state.chapterIndex=+e.target.value; state.selectedParagraph=0; state.selectedCharOffset=0; state.selectedWordEnd=0; await saveProgress(book); renderReader(); };
  $$('#readingPage p').forEach(p=>p.onclick=async e=>{
    const selection=window.getSelection?.();
    if(selection&&!selection.isCollapsed&&selection.toString().trim()){
      state.selectedReaderPhrase=selection.toString().trim();
      if(selectionPronunciation){selectionPronunciation.textContent=`Say “${excerpt(state.selectedReaderPhrase,34)}” as…`;selectionPronunciation.classList.remove('hidden')}
      return;
    }
    selectionPronunciation?.classList.add('hidden');
    const paragraphIndex=+p.dataset.p;
    const text=ch.paragraphs[paragraphIndex]||p.textContent||'';
    const offset=caretOffsetInParagraph(p,e);
    const seg=sentenceAtOffset(text,offset);
    if(!seg)return;
    stopAllSpeech();
    state.selectedParagraph=paragraphIndex;
    state.selectedCharOffset=seg.start;
    state.selectedWordEnd=wordRangeAt(text,seg.start).end;
    await saveProgress(book);
    $$('#readingPage p').forEach(el=>el.classList.toggle('selected',+el.dataset.p===paragraphIndex));
    const range=$('#positionRange');if(range)range.value=paragraphIndex;
    const label=$('#positionLabel');if(label)label.textContent=readerPositionLabel(book,state.chapterIndex,paragraphIndex,ch.paragraphs.length,`sentence starts “${excerpt(seg.text,54)}”`);
    highlightRange(paragraphIndex,seg.start,seg.end);
    startSpeechFromSelection();
  });
  $('#positionRange').oninput=e=>{stopAllSpeech();state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(+e.target.value,true);};
  $('#playBtn').onclick=toggleSpeech;
  $('#prevBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.max(0,state.selectedParagraph-1)); };
  $('#nextBtn').onclick=()=>{ stopAllSpeech(); state.selectedCharOffset=0;state.selectedWordEnd=0;selectParagraph(Math.min(ch.paragraphs.length-1,state.selectedParagraph+1)); };
  const repeatBtn=$('#repeatBtn');if(repeatBtn)repeatBtn.onclick=()=>{
    const enabled=!prefs().repeatParagraph;savePrefs({repeatParagraph:enabled});
    repeatBtn.classList.toggle('active',enabled);repeatBtn.setAttribute('aria-pressed',String(enabled));
    showToast(enabled?'Repeating paragraph':'Repeat off');
  };
  const recapResume=$('#recapResume');if(recapResume)recapResume.onclick=()=>{state.recapBookId=null;$('#recapCard')?.remove();scrollSelected(false)};
  const recapDismiss=$('#recapDismiss');if(recapDismiss)recapDismiss.onclick=()=>{state.recapBookId=null;$('#recapCard')?.remove()};
  const handoffDismiss=$('#dismissHandoffLanding');if(handoffDismiss)handoffDismiss.onclick=()=>{state.pendingHandoffContext=null;$('#handoffLandingCard')?.remove()};
  const recapStart=$('#recapChapterStart');if(recapStart)recapStart.onclick=async()=>{
    state.recapBookId=null;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;
    await saveProgress(book);await renderReader();
  };
  $('#testVoiceBtn').onclick=testVoice;
  $('#replayBtn').onclick=replayCurrentSentence;
  $('#sleepTimerSelect').onchange=e=>setSleepTimer(+e.target.value);
  $('#autoAdvanceToggle').onchange=e=>savePrefs({autoAdvance:e.target.checked});
  const rateSelect=$('#rateSelect');if(rateSelect)rateSelect.onchange=e=>{
    const rate=Number(e.target.value)||1.05;
    savePrefs({rate});
    const label=$('#speedLabel');if(label)label.textContent=rate.toFixed(2)+'×';
    updateVoiceSummary();updateReadingTimeMeta(book);refreshChapterTimeOptions(book);
    restartNarrationForSettingChange('Speed changed');
  };
  const voiceSelect=$('#voiceSelect'); if(voiceSelect) voiceSelect.onchange=e=>{
    const chosen=samanthaVoices().find(v=>voiceKey(v)===e.target.value);
    if(chosen)savePrefs({voiceKey:voiceKey(chosen),voiceName:chosen.name});
    updateVoiceSummary();
    restartNarrationForSettingChange('Samantha changed');
  };
  const readingStyle=$('#readingStyleSelect');if(readingStyle)readingStyle.onchange=e=>{
    savePrefs({readingStyle:e.target.value==='standard'?'standard':'natural'});
    updateVoiceSummary();
    restartNarrationForSettingChange('Reading style changed');
  };
  const dialogueToggle=$('#dialogueToggle'),dialogueControls=$('#dialogueControls');
  if(dialogueToggle)dialogueToggle.onchange=e=>{
    savePrefs({dialogueEnabled:e.target.checked});
    dialogueControls?.classList.toggle('hidden',!e.target.checked);
    restartNarrationForSettingChange(e.target.checked?'Dialogue voice on':'Dialogue voice off');
  };
  const dialogueVoice=$('#dialogueVoiceSelect');if(dialogueVoice)dialogueVoice.onchange=e=>{savePrefs({dialogueVoiceKey:e.target.value});restartNarrationForSettingChange('Dialogue voice changed')};
  const dialoguePitch=$('#dialoguePitchSelect');if(dialoguePitch)dialoguePitch.onchange=e=>{savePrefs({dialoguePitch:Number(e.target.value)||1});restartNarrationForSettingChange('Dialogue pitch changed')};
  const dialogueRate=$('#dialogueRateSelect');if(dialogueRate)dialogueRate.onchange=e=>{savePrefs({dialogueRateOffset:Number(e.target.value)||0});restartNarrationForSettingChange('Dialogue rate changed')};
}
function readerSearchResultsFromPanel(){
  const panel=$('#readerSearchResults');if(!panel?.dataset.searchResults)return [];
  try{return JSON.parse(panel.dataset.searchResults)}catch{return []}
}
function wireReaderSearchResults(book){
  const results=readerSearchResultsFromPanel();
  $$('[data-search-result]').forEach(btn=>btn.onclick=async e=>{
    const index=Number(btn.dataset.searchResult),result=results[index];if(!result)return;
    const play=!!e.target.closest('[data-search-play]');
    stopAllSpeech();
    state.chapterIndex=result.chapterIndex;state.selectedParagraph=result.paragraphIndex;
    const targetText=book.chapters[result.chapterIndex]?.paragraphs?.[result.paragraphIndex]||'';
    if(play){
      const seg=sentenceAtOffset(targetText,result.start);
      state.selectedCharOffset=seg?.start??result.start;
      state.selectedWordEnd=seg?wordRangeAt(targetText,seg.start).end:result.end;
      state.pendingPassageReference=null;
    }else{
      state.selectedCharOffset=result.start;state.selectedWordEnd=result.end;
      state.pendingPassageReference={chapterIndex:result.chapterIndex,paragraphIndex:result.paragraphIndex,start:result.start,end:result.end,moved:false};
    }
    await saveProgress(book);
    await renderReader();
    if(play){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      startSpeechFromSelection();
    }
  });
}
async function selectParagraph(i,noScroll=false,preserveWord=false){ state.selectedParagraph=i; if(!preserveWord){state.selectedCharOffset=0;state.selectedWordEnd=0;} $$('#readingPage p').forEach(p=>p.classList.toggle('selected',+p.dataset.p===i)); $('#positionRange').value=i; $('#positionLabel').textContent=readerPositionLabel(book,state.chapterIndex,i,$('#readingPage').children.length); const book=await idbGet('books',state.bookId); await saveProgress(book); updateReadingTimeMeta(book); if(!noScroll) scrollSelected(); }
function scrollSelected(smooth=true){ const el=$(`#readingPage p[data-p="${state.selectedParagraph}"]`); if(el) el.scrollIntoView({block:'center',behavior:smooth?'smooth':'auto'}); }
function updateFollowControl(){
  const btn=$('#resumeFollowBtn');if(btn)btn.classList.toggle('hidden',!state.followNarrationSuspended);
}
function followNarrationElement(el,{force=false}={}){
  if(!el||state.followNarrationSuspended)return;
  const page=$('#readingPage');if(!page)return;
  const pageRect=page.getBoundingClientRect(),rect=el.getBoundingClientRect();
  const margin=Math.min(96,Math.max(42,page.clientHeight*.2));
  const safeTop=pageRect.top+margin,safeBottom=pageRect.bottom-margin;
  const outside=rect.top<safeTop||rect.bottom>safeBottom;
  if(force||outside){
    const targetCenter=(rect.top+rect.bottom)/2;
    const pageCenter=(pageRect.top+pageRect.bottom)/2;
    page.scrollTo({top:page.scrollTop+(targetCenter-pageCenter),behavior:'smooth'});
  }
}
function resumeNarrationFollow(){
  state.followNarrationSuspended=false;updateFollowControl();
  const el=$(`#readingPage p[data-p="${state.speakingPIndex??state.selectedParagraph}"]`);
  followNarrationElement(el,{force:true});
}
function progressSnapshot(){return {chapterIndex:state.chapterIndex,paragraphIndex:state.selectedParagraph,charOffset:state.selectedCharOffset||0,wordEnd:state.selectedWordEnd||0}}
async function saveProgress(book,{snapshot=null,completed=null,updatePrefs=true}={}){
  if(!book)return;
  const pos=snapshot||progressSnapshot();
  const wasCompleted=book.progress?.completed===true,now=new Date().toISOString();
  book.progress={chapterIndex:pos.chapterIndex,paragraphIndex:pos.paragraphIndex,charOffset:pos.charOffset||0,wordEnd:pos.wordEnd||0,completed:completed===null?wasCompleted:!!completed,updatedAt:now};
  book.updatedAt=now;
  await idbPut('books',book);
  if(updatePrefs)savePrefs({lastBookId:book.id,lastChapterIndex:pos.chapterIndex,lastParagraphIndex:pos.paragraphIndex,lastCharOffset:pos.charOffset||0,lastWordEnd:pos.wordEnd||0});
}
function persistReadingProgress(){
  const bookId=state.bookId,snapshot=progressSnapshot();
  if(!bookId)return;
  idbGet('books',bookId).then(book=>book&&saveProgress(book,{snapshot,updatePrefs:false})).catch(()=>{});
}
function updateVoiceSummary(){
  const sel=$('#voiceSelect'); const summary=$('#voiceSummary'); const st=$('#voiceStatus');
  const option=sel?.selectedOptions?.[0],name=option?.dataset?.name||prefs().voiceName||'Samantha';
  const rate=Number(prefs().rate||1.05),style=(prefs().readingStyle||'natural')==='standard'?'Standard':'Natural';
  if(summary)summary.textContent=`${name} · ${style} · ${rate.toFixed(2)}×`;
  if(st&&!state.isSpeaking)st.textContent=state.voicesReady?`${option?.textContent||name} ready`:'Samantha unavailable';
}
function setSpeechControlsReady(ready){
  state.voicesReady=!!ready;
  const play=$('#playBtn'); if(play){play.disabled=!ready;play.setAttribute('aria-disabled',String(!ready));}
  $$('[data-reader-act="start"]').forEach(b=>{b.disabled=!ready;b.setAttribute('aria-disabled',String(!ready))});
  const st=$('#voiceStatus');
  if(st&&!state.isSpeaking){
    const label=$('#voiceSelect')?.selectedOptions?.[0]?.textContent||prefs().voiceName||'Samantha';
    st.textContent=ready?`${label} ready`:'Loading Samantha…';
  }
}
function loadVoices(){
  const optionHtml=v=>`<option value="${escapeHtml(voiceKey(v))}" data-name="${escapeHtml(v.name)}">${escapeHtml(voiceDisplayName(v))}</option>`;
  const groupHtml=(label,voices)=>voices.length?`<optgroup label="${escapeHtml(label)}">${voices.map(optionHtml).join('')}</optgroup>`:'';
  const fill=()=>{
    const allVoices=speechSynthesis.getVoices();
    state.voices=allVoices;
    const sel=$('#voiceSelect');if(!sel)return;
    if(!allVoices.length){
      sel.innerHTML='<option>Loading Samantha…</option>';
      setSpeechControlsReady(false);
      return;
    }

    const p=prefs();
    const samanthas=samanthaVoices().sort((a,b)=>{
      if(a.localService!==b.localService)return a.localService?-1:1;
      return voiceDisplayName(a).localeCompare(voiceDisplayName(b));
    });
    const installed=samanthas.filter(v=>v.localService);
    const online=samanthas.filter(v=>!v.localService);
    sel.innerHTML=groupHtml('Samantha · on device',installed)+groupHtml('Samantha · online',online);
    const dialogueSel=$('#dialogueVoiceSelect');
    if(dialogueSel){
      dialogueSel.innerHTML='<option value="">Same Samantha</option>'+groupHtml('Samantha · on device',installed)+groupHtml('Samantha · online',online);
      const wantedDialogue=p.dialogueVoiceKey||'';
      dialogueSel.value=samanthas.some(v=>voiceKey(v)===wantedDialogue)?wantedDialogue:'';
    }
    const availability=$('#voiceAvailabilityNote');
    if(availability){
      const parts=[];
      if(installed.length)parts.push(`${installed.length} on device`);
      if(online.length)parts.push(`${online.length} online`);
      availability.textContent=samanthas.length
        ? `This browser currently exposes ${samanthas.length} Samantha voice${samanthas.length===1?'':'s'} (${parts.join(', ')}). Storyline can only show voices the browser provides.`
        : 'This browser is not currently exposing a Samantha voice to Storyline.';
    }

    if(!samanthas.length){
      sel.innerHTML='<option value="">Samantha is not available in this browser</option>';
      setSpeechControlsReady(false);
      const st=$('#voiceStatus');if(st)st.textContent='Samantha unavailable on this device';
      updateVoiceSummary();
      return;
    }

    let wanted=p.voiceKey||'';
    if(!samanthas.some(v=>voiceKey(v)===wanted)){
      const sameName=samanthas.find(v=>v.name===p.voiceName);
      wanted=voiceKey(sameName||installed[0]||samanthas[0]);
    }
    sel.value=wanted;
    const chosen=samanthas.find(v=>voiceKey(v)===sel.value)||installed[0]||samanthas[0];
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
function setMediaPlaybackState(value){
  if(!('mediaSession' in navigator))return;
  try{navigator.mediaSession.playbackState=value}catch{}
}
async function updateNowPlaying(){
  if(!('mediaSession' in navigator)||typeof MediaMetadata==='undefined'||!state.bookId)return;
  try{
    const book=await idbGet('books',state.bookId);if(!book)return;
    const ch=book.chapters[state.chapterIndex];
    navigator.mediaSession.metadata=new MediaMetadata({
      title:book.title||'Manuscript',
      artist:'Storyline Studio',
      album:chapterLabel(ch,book)
    });
  }catch{}
}
async function mediaMoveParagraph(delta){
  const book=await idbGet('books',state.bookId);if(!book)return;
  let ci=state.chapterIndex,pi=state.selectedParagraph;
  const ch=book.chapters[ci];if(!ch?.paragraphs?.length)return;
  if(delta>0){
    if(pi<ch.paragraphs.length-1)pi++;
    else if(ci<book.chapters.length-1){ci++;pi=0}
  }else if(delta<0){
    if(pi>0)pi--;
    else if(ci>0){ci--;pi=Math.max(0,(book.chapters[ci].paragraphs?.length||1)-1)}
  }
  stopAllSpeech();
  state.chapterIndex=ci;state.selectedParagraph=pi;
  state.selectedCharOffset=0;state.selectedWordEnd=0;
  await saveProgress(book);
  await renderReader();
  updateNowPlaying();
  startSpeechFromSelection();
}
function setupMediaSession(){
  if(!('mediaSession' in navigator))return;
  const safe=(name,handler)=>{try{navigator.mediaSession.setActionHandler(name,handler)}catch{}};
  safe('play',()=>{
    if(state.isSpeaking&&state.isPaused){
      try{speechSynthesis.resume()}catch{}
      state.isPaused=false;
      const b=$('#playBtn');if(b){b.textContent='Ⅱ';b.setAttribute('aria-label','Pause')}
      setMediaPlaybackState('playing');
      return;
    }
    if(!state.isSpeaking)startSpeechFromSelection();
  });
  safe('pause',()=>{
    if(!state.isSpeaking||state.isPaused)return;
    try{speechSynthesis.pause()}catch{}
    state.isPaused=true;
    const b=$('#playBtn');if(b){b.textContent='▶';b.setAttribute('aria-label','Play')}
    setMediaPlaybackState('paused');
  });
  safe('previoustrack',()=>{mediaMoveParagraph(-1)});
  safe('nexttrack',()=>{mediaMoveParagraph(1)});
  safe('stop',()=>stopAllSpeech());
}
function startSpeechFromSelection(){
  if(currentEngine()==='local'){startLocalSpeech(true);return}
  startSpeech(true);
}
function restartNarrationForSettingChange(message='Playback setting changed'){
  const wasSpeaking=state.isSpeaking,wasPaused=state.isPaused,engine=currentEngine();
  const followSuspended=state.followNarrationSuspended;
  if(!wasSpeaking){showToast(message);return}

  state.playbackToken++;
  try{speechSynthesis.cancel()}catch{}
  try{if(window.meSpeak)meSpeak.stop()}catch{}
  state.isSpeaking=false;state.isPaused=false;state.activeUtterance=null;state.localSpeakingId=null;state.speakingParagraph=null;
  state.speakingPIndex=null;state.speakingSIndex=null;state.speakingSegments=null;state.replayCurrent=null;
  setMediaPlaybackState('none');
  const play=$('#playBtn');if(play){play.textContent='▶';play.setAttribute('aria-label','Play')}
  const replay=$('#replayBtn');if(replay)replay.disabled=true;
  state.followNarrationSuspended=followSuspended;updateFollowControl();

  if(wasPaused){showToast(message+' · press Play to resume');return}
  requestAnimationFrame(()=>{
    state.followNarrationSuspended=followSuspended;updateFollowControl();
    if(engine==='local')startLocalSpeech(true,{preserveFollow:true});
    else startSpeech(true,{preserveFollow:true});
    state.followNarrationSuspended=followSuspended;updateFollowControl();
    showToast(message);
  });
}
function toggleSpeech(){
  if(currentEngine()==='local'){
    if(state.isSpeaking){stopAllSpeech();return}
    startLocalSpeech(true);return;
  }
  if(!state.voicesReady){showToast('Device voices are still loading.');return}
  if(!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance==='undefined'){ showToast('Text-to-speech is not available in this browser.'); return; }
  if(state.isSpeaking&&!state.isPaused){ speechSynthesis.pause(); state.isPaused=true; $('#playBtn').textContent='▶'; setMediaPlaybackState('paused'); return; }
  if(state.isSpeaking&&state.isPaused){ speechSynthesis.resume(); state.isPaused=false; $('#playBtn').textContent='Ⅱ'; setMediaPlaybackState('playing'); return; }
  startSpeech(true);
}
function startSpeech(fromSelected=true,{preserveFollow=false}={}){
  state.activeEngine='device';
  if(fromSelected&&!preserveFollow){state.followNarrationSuspended=false;updateFollowControl()}
  if(!state.voicesReady){showToast('Samantha is still loading.');return}
  if(!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance==='undefined'){showToast('Text-to-speech is not available in this browser.');return}
  const paras=$$('#readingPage p').map(p=>(p.textContent||'').trim());
  if(!paras.some(Boolean)){showToast('There is no text to read in this chapter.');return}
  const book=state.readerBook;
  if(!book){showToast('The manuscript is still loading.');return}

  const token=++state.playbackToken;
  try{speechSynthesis.cancel()}catch{}
  speechSynthesis.resume();

  let pIndex=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  pIndex=Math.max(0,Math.min(pIndex,paras.length-1));
  let firstOffset=fromSelected?(state.selectedCharOffset||0):0;

  state.isSpeaking=true;state.isPaused=false;
  setMediaPlaybackState('playing');updateNowPlaying();
  requestWakeLock();
  const st=$('#voiceStatus');
  if(st)st.textContent=state.chapterTransitionNotice||'Starting…';
  state.chapterTransitionNotice='';
  const play=$('#playBtn');if(play){play.textContent='Ⅱ';play.setAttribute('aria-label','Pause')}
  const replay=$('#replayBtn');if(replay)replay.disabled=true;

  const mainVoice=()=>{
    const p=prefs(),selectedKey=$('#voiceSelect')?.value||p.voiceKey;
    const voices=samanthaVoices();
    return voices.find(x=>voiceKey(x)===selectedKey)||
      voices.find(x=>x.name===p.voiceName)||
      voices.find(x=>x.localService)||
      voices[0]||null;
  };
  const dialogueVoice=()=>{
    const p=prefs(),voices=samanthaVoices(),key=p.dialogueVoiceKey||'';
    return voices.find(x=>voiceKey(x)===key)||mainVoice();
  };

  const continueChapter=async()=>{
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const fresh=await idbGet('books',state.bookId);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    if(!fresh){finishSpeech(token);return}
    state.readerBook=fresh;
    if(state.chapterIndex>=fresh.chapters.length-1){await saveProgress(fresh,{completed:true});finishSpeech(token);return}
    if(prefs().autoAdvance===false){finishSpeech(token);return}
    const completedLabel=chapterLabel(fresh.chapters[state.chapterIndex],fresh);
    state.chapterIndex++;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;state.speakingParagraph=null;
    await saveProgress(fresh);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const notice=`${completedLabel} complete · continuing to ${chapterLabel(fresh.chapters[state.chapterIndex],fresh)}…`;
    state.chapterTransitionNotice=notice;showToast(notice);
    await renderReader();updateNowPlaying();
    if(token!==state.playbackToken||!state.isSpeaking)return;
    startSpeech(false,{preserveFollow:true});
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
    const label=$('#positionLabel');if(label)label.textContent=readerPositionLabel(book,state.chapterIndex,pIndex,paras.length);

    const p=prefs();
    const naturalMode=(p.readingStyle||'natural')==='natural';
    const dialogueEnabled=!!p.dialogueEnabled;

    const setSentenceState=index=>{
      const seg=segments[index];if(!seg)return;
      state.speakingPIndex=pIndex;state.speakingSIndex=index;state.speakingSegments=segments;
      const startWord=wordRangeAt(full,seg.start);
      state.selectedCharOffset=seg.start;state.selectedWordEnd=startWord.end;state.liveCharOffset=seg.start;
      persistReadingProgress();
      updateReadingTimeMeta(book);
      highlightRange(pIndex,seg.start,seg.end);
      if(st)st.textContent=`${naturalMode?'Natural · ':''}paragraph ${pIndex+1} · sentence ${index+1}/${segments.length}`;
      if(replay)replay.disabled=false;
    };
    const sentenceIndexAtSource=absolute=>{
      for(let i=0;i<segments.length;i++)if(absolute<segments[i].end)return i;
      return Math.max(0,segments.length-1);
    };
    const speakPiece=(piece,onDone,onMappedBoundary=null)=>{
      const u=new SpeechSynthesisUtterance(piece.text);
      state.activeUtterance=u;
      const settings=prefs(),isDialogue=piece.kind==='dialogue'&&settings.dialogueEnabled;
      const v=isDialogue?dialogueVoice():mainVoice();
      const baseRate=Number(settings.rate||1.05);
      u.rate=Math.max(.5,Math.min(2,isDialogue?baseRate+Number(settings.dialogueRateOffset||0):baseRate));
      u.volume=1;u.pitch=isDialogue?Number(settings.dialoguePitch??1.15):1;
      if(v){u.voice=v;u.lang=v.lang}else{u.lang='en-US'}
      u.onstart=()=>{if(token===state.playbackToken&&state.activeUtterance===u)requestWakeLock()};
      u.onboundary=e=>{
        if(token!==state.playbackToken||state.activeUtterance!==u||!onMappedBoundary)return;
        const rel=Number(e.charIndex);if(!Number.isFinite(rel))return;
        onMappedBoundary(piece.mapIndex(rel));
      };
      u.onend=()=>{if(token!==state.playbackToken||state.activeUtterance!==u)return;state.activeUtterance=null;onDone()};
      u.onerror=e=>{
        if(token!==state.playbackToken||state.activeUtterance!==u)return;
        state.activeUtterance=null;
        if(e.error==='canceled'||e.error==='interrupted')return;
        showToast('Samantha could not continue reading.');finishSpeech(token);
      };
      speechSynthesis.speak(u);
    };
    const speakRange=(sourceStart,sourceEnd,onDone)=>{
      const pieces=speechPiecesForRange(full,sourceStart,sourceEnd,book,{dialogueEnabled});
      let pieceIndex=0,highlighted=sentenceIndexAtSource(sourceStart);
      setSentenceState(highlighted);
      const nextPiece=()=>{
        if(token!==state.playbackToken||!state.isSpeaking)return;
        if(pieceIndex>=pieces.length){onDone();return}
        const piece=pieces[pieceIndex++];
        speakPiece(piece,nextPiece,sourceIndex=>{
          state.liveCharOffset=Math.max(0,Math.min(sourceIndex,full.length));
          const liveWord=wordRangeAt(full,state.liveCharOffset);state.selectedWordEnd=Math.max(state.liveCharOffset,liveWord.end||state.liveCharOffset);
          const next=sentenceIndexAtSource(sourceIndex);
          if(next!==highlighted){highlighted=next;setSentenceState(next)}
        });
      };
      nextPiece();
    };

    const naturalChunkFrom=index=>{
      const startIndex=index,startChar=segments[index].start;
      let endIndex=index;
      while(endIndex+1<segments.length&&endIndex-startIndex<5){
        const candidateEnd=segments[endIndex+1].end;
        if(candidateEnd-startChar>900)break;
        endIndex++;
      }
      return {startIndex,endIndex,startChar,endChar:segments[endIndex].end};
    };

    const speakNext=()=>{
      if(token!==state.playbackToken||!state.isSpeaking)return;
      if(sIndex>=segments.length){
        const currentP=$(`#readingPage p[data-p="${pIndex}"]`);if(currentP)currentP.textContent=full;
        if(prefs().repeatParagraph){
          state.selectedCharOffset=0;state.selectedWordEnd=0;firstOffset=0;
          persistReadingProgress();speakParagraph();return;
        }
        state.selectedCharOffset=full.length;state.selectedWordEnd=full.length;
        persistReadingProgress();pIndex++;firstOffset=0;speakParagraph();return;
      }

      if(!naturalMode){
        const index=sIndex,seg=segments[index];
        setSentenceState(index);
        state.replayCurrent=()=>{
          if(token!==state.playbackToken||!state.isSpeaking)return;
          state.isPaused=false;
          const b=$('#playBtn');if(b){b.textContent='Ⅱ';b.setAttribute('aria-label','Pause')}
          try{speechSynthesis.cancel()}catch{};speechSynthesis.resume();
          speakRange(seg.start,seg.end,()=>{sIndex=index+1;speakNext()});
        };
        speakRange(seg.start,seg.end,()=>{sIndex=index+1;speakNext()});
        return;
      }

      const chunk=naturalChunkFrom(sIndex);
      const replayIndex=sIndex,replaySeg=segments[replayIndex];
      state.replayCurrent=()=>{
        if(token!==state.playbackToken||!state.isSpeaking)return;
        state.isPaused=false;
        const b=$('#playBtn');if(b){b.textContent='Ⅱ';b.setAttribute('aria-label','Pause')}
        try{speechSynthesis.cancel()}catch{};speechSynthesis.resume();
        speakRange(replaySeg.start,replaySeg.end,()=>{sIndex=replayIndex+1;speakNext()});
      };
      speakRange(chunk.startChar,chunk.endChar,()=>{sIndex=chunk.endIndex+1;speakNext()});
    };
    speakNext();
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
  setMediaPlaybackState('none');
  state.speakingPIndex=null;state.speakingSIndex=null;state.speakingSegments=null;state.replayCurrent=null;state.liveCharOffset=null;
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
function highlightSentence(paragraphIndex,sentenceIndex,parts){
  const part=parts[sentenceIndex];
  if(!part)return;
  highlightRange(paragraphIndex,part.start,part.end);
}
function clearSentenceHighlights(){
  $$('#readingPage p').forEach(p=>{
    if(p.querySelector('.sentence-speaking')) p.textContent=p.textContent;
  });
}
async function startLocalSpeech(fromSelected=true,{preserveFollow=false}={}){
  state.activeEngine='local';
  if(fromSelected&&!preserveFollow){state.followNarrationSuspended=false;updateFollowControl()}
  const token=++state.playbackToken;
  const paras=$$('#readingPage p').map(p=>(p.textContent||'').trim());
  if(!paras.some(Boolean)){showToast('There is no text to read in this chapter.');return}
  const book=state.readerBook;
  if(!book){showToast('The manuscript is still loading.');return}
  let pIndex=fromSelected?state.selectedParagraph:(state.speakingParagraph??state.selectedParagraph);
  pIndex=Math.max(0,Math.min(pIndex,paras.length-1));
  let firstOffset=fromSelected?(state.selectedCharOffset||0):0;
  const st=$('#voiceStatus');if(st)st.textContent=state.chapterTransitionNotice||'Loading free local voice…';
  state.chapterTransitionNotice='';
  const play=$('#playBtn');if(play)play.textContent='…';
  try{await ensureLocalTTS()}catch(e){if(token!==state.playbackToken)return;if(st)st.textContent='Local voice failed to load';if(play)play.textContent='▶';showToast(e.message);return}
  if(token!==state.playbackToken)return;
  try{meSpeak.stop()}catch{}
  state.isSpeaking=true;state.isPaused=false;requestWakeLock();
  if(play){play.textContent='■';play.setAttribute('aria-label','Stop')}

  const continueLocalChapter=async()=>{
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const fresh=await idbGet('books',state.bookId);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    if(!fresh){finishSpeech(token);return}
    state.readerBook=fresh;
    if(state.chapterIndex>=fresh.chapters.length-1){await saveProgress(fresh,{completed:true});finishSpeech(token);return}
    if(prefs().autoAdvance===false){finishSpeech(token);return}
    const completedLabel=chapterLabel(fresh.chapters[state.chapterIndex],fresh);
    state.chapterIndex++;state.selectedParagraph=0;state.selectedCharOffset=0;state.selectedWordEnd=0;state.speakingParagraph=null;
    await saveProgress(fresh);
    if(token!==state.playbackToken||!state.isSpeaking)return;
    const notice=`${completedLabel} complete · continuing to ${chapterLabel(fresh.chapters[state.chapterIndex],fresh)}…`;
    state.chapterTransitionNotice=notice;showToast(notice);
    await renderReader();
    if(token!==state.playbackToken||!state.isSpeaking)return;
    startLocalSpeech(false,{preserveFollow:true});
  };

  const speakParagraph=()=>{
    if(token!==state.playbackToken||!state.isSpeaking)return;
    if(pIndex>=paras.length){continueLocalChapter();return}
    const full=paras[pIndex],sentenceParts=sentenceSegments(full,0);
    let sIndex=0;
    if(pIndex===state.selectedParagraph&&firstOffset>0){
      const found=sentenceParts.findIndex(x=>firstOffset>=x.start&&firstOffset<x.end);
      sIndex=found>=0?found:Math.max(0,sentenceParts.findIndex(x=>x.start>=firstOffset));
      if(sIndex<0)sIndex=Math.max(0,sentenceParts.length-1);
    }
    state.speakingParagraph=pIndex;state.selectedParagraph=pIndex;markSpeaking(pIndex);
    const range=$('#positionRange');if(range)range.value=pIndex;
    const label=$('#positionLabel');if(label)label.textContent=readerPositionLabel(book,state.chapterIndex,pIndex,paras.length);

    const speakSentence=()=>{
      if(token!==state.playbackToken||!state.isSpeaking)return;
      if(sIndex>=sentenceParts.length){
        const currentP=$(`#readingPage p[data-p="${pIndex}"]`);if(currentP)currentP.textContent=full;
        if(prefs().repeatParagraph){
          state.selectedCharOffset=0;state.selectedWordEnd=0;firstOffset=0;
          persistReadingProgress();speakParagraph();return;
        }
        state.selectedCharOffset=full.length;state.selectedWordEnd=full.length;
        persistReadingProgress();pIndex++;firstOffset=0;speakParagraph();return;
      }
      const sentenceIndex=sIndex,part=sentenceParts[sentenceIndex],settings=prefs();
      state.speakingPIndex=pIndex;state.speakingSIndex=sentenceIndex;state.speakingSegments=sentenceParts;
      state.selectedCharOffset=part.start;state.selectedWordEnd=wordRangeAt(full,part.start).end;state.liveCharOffset=part.start;
      persistReadingProgress();updateReadingTimeMeta(book);highlightSentence(pIndex,sentenceIndex,sentenceParts);
      if(st)st.textContent=`Reading paragraph ${pIndex+1} · sentence ${sentenceIndex+1}/${sentenceParts.length}`;
      const pieces=speechPiecesForRange(full,part.start,part.end,book,{dialogueEnabled:!!settings.dialogueEnabled});
      let pieceIndex=0;
      const speakPiece=()=>{
        if(token!==state.playbackToken||!state.isSpeaking)return;
        if(pieceIndex>=pieces.length){sIndex=sentenceIndex+1;speakSentence();return}
        const piece=pieces[pieceIndex++],isDialogue=piece.kind==='dialogue'&&settings.dialogueEnabled;
        const rate=Math.max(.5,Math.min(2,Number(settings.rate||1.05)+(isDialogue?Number(settings.dialogueRateOffset||0):0)));
        const speed=Math.max(90,Math.min(310,Math.round(170*rate)));
        const pitch=isDialogue?Math.max(20,Math.min(80,Math.round(50*Number(settings.dialoguePitch??1.15)))):50;
        const id=meSpeak.speak(piece.text,{amplitude:100,speed,volume:1,pitch,voice:'en-us',variant:localVoiceVariant()},success=>{
          if(token!==state.playbackToken)return;
          state.localSpeakingId=null;if(!state.isSpeaking)return;
          if(!success){finishSpeech(token);return}
          speakPiece();
        });
        if(!id){showToast('The local voice could not generate this sentence.');finishSpeech(token);return}
        state.localSpeakingId=id;
      };
      speakPiece();
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
  const p=prefs(),selectedKey=$('#voiceSelect')?.value||p.voiceKey;
  const voices=samanthaVoices();
  const v=voices.find(x=>voiceKey(x)===selectedKey)||voices.find(x=>x.localService)||voices[0];
  if(!v){showToast('Samantha is not available in this browser.');return}

  const source=$(`#readingPage p[data-p="${state.selectedParagraph}"]`)?.textContent||'';
  const start=Math.max(0,Math.min(state.selectedCharOffset||0,source.length));
  const parts=sentenceSegments(source,start);
  const natural=(p.readingStyle||'natural')==='natural';
  let sample='Storyline Studio Samantha preview.';
  if(parts.length){
    if(natural){
      let end=0;
      while(end+1<parts.length&&end<2&&parts[end+1].end-parts[0].start<=420)end++;
      sample=source.slice(parts[0].start,parts[end].end);
    }else sample=parts[0].text;
  }

  const u=new SpeechSynthesisUtterance(sample);
  state.activeUtterance=u;
  u.volume=1;u.rate=+(p.rate||1.05);u.pitch=1;u.voice=v;u.lang=v.lang||'en-US';
  const st=$('#voiceStatus');
  if(st)st.textContent=`Previewing ${voiceDisplayName(v)}…`;
  u.onstart=()=>{if(state.activeUtterance!==u)return;showToast('Samantha preview started')};
  u.onend=()=>{if(state.activeUtterance!==u)return;state.activeUtterance=null;if(st)st.textContent=`${voiceDisplayName(v)} ready`;showToast('Samantha preview finished')};
  u.onerror=e=>{if(state.activeUtterance!==u)return;state.activeUtterance=null;if(e.error==='canceled'||e.error==='interrupted')return;if(st)st.textContent='Samantha preview error';showToast('Samantha preview could not continue')};
  speechSynthesis.resume();
  speechSynthesis.speak(u);
}
function markSpeaking(i){
  $$('#readingPage p').forEach(p=>p.classList.toggle('speaking',+p.dataset.p===i));
  const el=$(`#readingPage p[data-p="${i}"]`);
  followNarrationElement(el);
  const st=$('#voiceStatus');
  if(st) st.textContent=`Reading paragraph ${i+1}`;
}
function finishSpeech(token=null){
  if(token!==null&&token!==state.playbackToken)return;
  state.isSpeaking=false;state.isPaused=false;state.speakingParagraph=null;state.activeUtterance=null;state.localSpeakingId=null;
  setMediaPlaybackState('none');
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
async function handleAction(act,book,ch){
  const text=ch.paragraphs[state.selectedParagraph]||'';
  const spoken=(state.isSpeaking&&state.speakingPIndex===state.selectedParagraph&&state.speakingSegments?.[state.speakingSIndex])?state.speakingSegments[state.speakingSIndex]:null;
  const anchor=makePassageAnchor(book,ch,state.selectedParagraph,text,{start:state.selectedCharOffset||0,end:state.selectedWordEnd||0,spokenSegment:spoken,precision:'sentence'});
  const base={
    bookId:book.id,bookTitle:book.title,chapterIndex:state.chapterIndex,chapterTitle:chapterLabel(ch,book),
    paragraphIndex:state.selectedParagraph,charOffset:anchor.charStart||0,wordEnd:anchor.charEnd||anchor.charStart||0,
    anchor,excerpt:excerpt(anchor.selectedText||text),createdAt:new Date().toISOString(),status:'open'
  };
  if(act==='start'){ startSpeechFromSelection(); return} if(act==='queue'){navigate('queue');return}
  if(act==='handoff'){openHandoffSender(book);return}
  if(act==='pronunciations'){pronunciationManager(book,selectedReaderText());return}
  if(act==='bookmark'){await idbPut('items',{...base,id:uid(),type:'bookmark',note:''});showToast('Bookmarked');updateQueueBadge();return}
  if(act==='note') return promptItem('note','Add note','What did you notice?',base);
  if(act==='continuity') return promptItem('continuity','Flag continuity','What seems inconsistent or needs checking?',base);
  if(act==='ask') return promptItem('question','Ask ChatGPT later','What do you want me to check, explain, or revise?',base);
  if(act==='voice') return voiceNote(base);
}
function promptItem(type,title,placeholder,base){
  modalForm.innerHTML=`<h3>${title}</h3><div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1} · exact passage</div><div class="excerpt passage-preview">${referenceExcerptHtml(base)}</div><textarea id="itemText" placeholder="${escapeHtml(placeholder)}" autofocus></textarea><div class="row between"><button value="cancel" class="button secondary">Cancel</button><div class="row"><button type="button" id="dictateItem" class="ghost">🎙 Dictate</button><button id="saveItem" value="default" class="button">Save</button></div></div>`;
  modal.showModal();
  attachDictation($('#dictateItem'),$('#itemText'));
  setTimeout(()=>$('#itemText')?.focus(),50);
  $('#saveItem').onclick=async e=>{e.preventDefault();const note=$('#itemText').value.trim(); if(!note){showToast('Add a note first');return} await idbPut('items',{...base,id:uid(),type,note}); modal.close(); showToast(type==='question'?'Added to revision queue':'Saved'); updateQueueBadge();};
}
async function voiceNote(base){
  const canRecord=!!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let stream=null,recorder=null,chunks=[],audioBlob=null,previewUrl=null,recording=false,recordStartedAt=0,audioDurationSec=0,timer=null;

  modalForm.innerHTML=`<h3>Voice note</h3>
    <div class="source-chip">${escapeHtml(base.chapterTitle)} · paragraph ${base.paragraphIndex+1} · exact passage</div>
    <div class="excerpt passage-preview">${referenceExcerptHtml(base)}</div>
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
  view.innerHTML=`<section class="hero"><div class="eyebrow">Listening memory</div><h1>Notes & bookmarks</h1><p class="sub">Everything you caught while listening, still attached to where you heard it.</p></section>${items.length?`<div class="list">${items.map(i=>itemHtml(i,bookMap)).join('')}</div>`:`<div class="empty card">No notes yet. This is suspiciously peaceful.</div>`}`; wireItemButtons(items); }
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

  wireItemButtons(pending);
  wireQueueBulk(pending);
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
  wireItemButtons(items);
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
    <div><strong>${escapeHtml(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript')}</strong><div class="source-chip">${escapeHtml((i.chapterTitle==='Beginning'||i.chapterTitle==='Front matter')?(bookMap[i.bookId]?.title||i.bookTitle||'Manuscript'):(i.chapterTitle||'Chapter'))} · paragraph ${(i.paragraphIndex??0)+1}${i.anchor?' · anchored':''}</div></div>
    <div class="excerpt passage-reference-preview">${referenceExcerptHtml(i)}</div>
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
  const a=i.anchor;
  const reference=a?`\nAnchor: ${a.chapterTitle||i.chapterTitle}, paragraph ${(a.paragraphIndex??i.paragraphIndex??0)+1}, ${a.precision||'passage'} reference\nSelected passage: ${a.selectedText||i.excerpt||''}\nContext before: ${a.prefixContext||''}\nContext after: ${a.suffixContext||''}`:`\nPassage: ${i.excerpt||''}`;
  return `Storyline Studio revision item\n\nBook: ${i.bookTitle}\nLocation when captured: ${i.chapterTitle}, paragraph ${(i.paragraphIndex||0)+1}\nType: ${i.type}\nCreated: ${formatItemTime(i.createdAt)}${reference}\n\nMy note/question:\n${i.note||''}${audioNote}\n\nPlease answer using the manuscript context I provide, and do not revise the manuscript unless I explicitly ask.`;
}
function fallbackCopyText(text){
  const ta=document.createElement('textarea');
  ta.value=text;ta.setAttribute('readonly','');
  ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length);
  let ok=false;try{ok=document.execCommand('copy')}catch{}
  ta.remove();return ok;
}
function showManualCopy(text){
  modalForm.innerHTML=`<h3>Copy text</h3><p class="sub">Automatic copy was blocked by the browser. The full text is selected below so you can copy it manually.</p><textarea id="manualCopyText" class="manual-copy-text" readonly>${escapeHtml(text)}</textarea><div class="row between"><span class="meta">Press and hold, then Copy.</span><button value="default" class="button">Close</button></div>`;
  modal.showModal();
  requestAnimationFrame(()=>{const ta=$('#manualCopyText');if(ta){ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length)}});
}
function copyTextReliable(text,successMessage='Copied'){
  if(!text)return false;
  const failed=()=>{if(fallbackCopyText(text))showToast(successMessage);else showManualCopy(text)};
  if(navigator.clipboard?.writeText){
    try{
      const result=navigator.clipboard.writeText(text);
      Promise.resolve(result).then(()=>showToast(successMessage)).catch(failed);
      return true;
    }catch{}
  }
  if(fallbackCopyText(text)){showToast(successMessage);return true}
  showManualCopy(text);return false;
}
function copyItemsForChat(items){
  if(!items.length)return false;
  const text=items.map((i,n)=>`--- Item ${n+1} of ${items.length} ---\n${chatPacket(i)}`).join('\n\n');
  return copyTextReliable(text,items.length===1?'Copied for ChatGPT':`Copied ${items.length} items for ChatGPT`);
}
function selectedQueueIds(){return $$('.queue-item-check:checked').map(c=>c.dataset.selectItem)}
function updateBulkBar(){
  const ids=selectedQueueIds(); const count=$('#selectedCount'); if(count)count.textContent=`${ids.length} selected`;
  ['#bulkDone','#bulkCopy','#bulkDelete'].forEach(sel=>{const b=$(sel);if(b)b.disabled=!ids.length});
  const all=$$('.queue-item-check'); const selectAll=$('#selectAllQueue');
  if(selectAll){selectAll.checked=!!all.length&&ids.length===all.length;selectAll.indeterminate=ids.length>0&&ids.length<all.length}
}
function wireQueueBulk(visibleItems=[]){
  const visibleMap=new Map(visibleItems.map(i=>[i.id,i]));
  const selectAll=$('#selectAllQueue'); if(!selectAll)return;
  selectAll.onchange=()=>{$$('.queue-item-check').forEach(c=>c.checked=selectAll.checked);updateBulkBar()};
  $$('.queue-item-check').forEach(c=>c.onchange=updateBulkBar);
  $('#bulkDone').onclick=async()=>{
    const ids=selectedQueueIds(); if(!ids.length)return;
    if(!confirm(`Mark ${ids.length} selected item${ids.length===1?'':'s'} as done?`))return;
    for(const id of ids){const i=await idbGet('items',id);if(i){i.status='done';i.completedAt=new Date().toISOString();await idbPut('items',i)}}
    navigate('queue');
  };
  $('#bulkCopy').onclick=()=>{
    const items=selectedQueueIds().map(id=>visibleMap.get(id)).filter(Boolean);
    copyItemsForChat(items);
  };
  $('#bulkDelete').onclick=async()=>{
    const ids=selectedQueueIds(); if(!ids.length)return;
    if(!confirm(`Delete ${ids.length} selected item${ids.length===1?'':'s'}? This cannot be undone.`))return;
    for(const id of ids)await idbDelete('items',id);
    navigate('queue');
  };
  updateBulkBar();
}
function wireItemButtons(visibleItems=[]){
  const visibleMap=new Map(visibleItems.map(i=>[i.id,i]));
  $$('[data-audio-item]').forEach(async a=>{
    const i=visibleMap.get(a.dataset.audioItem)||await idbGet('items',a.dataset.audioItem);
    let blob=null;
    if(i?.audioData)blob=new Blob([i.audioData],{type:i.audioType||'audio/mp4'});
    else if(i?.audioBlob)blob=i.audioBlob;
    if(blob){const u=URL.createObjectURL(blob);savedAudioObjectUrls.add(u);a.src=u;a.dataset.objectUrl=u;}
  });
  $$('[data-open-item]').forEach(b=>b.onclick=async()=>{
    const i=await idbGet('items',b.dataset.openItem);
    if(!i)return;
    let book=await idbGet('books',i.bookId);
    if(!book){
      const candidates=(await idbGetAll('books')).filter(x=>x.title===i.bookTitle);
      if(candidates.length===1)book=candidates[0];
    }
    if(!book){showToast('That manuscript is no longer in this browser.');return}
    const resolved=resolvePassageAnchor(book,i);
    state.bookId=book.id;state.chapterIndex=resolved.chapterIndex;state.selectedParagraph=resolved.paragraphIndex;
    state.selectedCharOffset=resolved.start||0;state.selectedWordEnd=resolved.end||resolved.start||0;
    state.pendingPassageReference=resolved;
    i.lastResolved={bookId:book.id,chapterIndex:resolved.chapterIndex,paragraphIndex:resolved.paragraphIndex,charStart:resolved.start||0,charEnd:resolved.end||0,score:resolved.score||0,moved:!!resolved.moved,unverified:!!resolved.unverified,resolvedAt:new Date().toISOString()};
    await idbPut('items',i);
    savePrefs({lastBookId:state.bookId});await saveProgress(book);navigate('reader');
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
  $$('[data-copy]').forEach(b=>b.onclick=()=>{const i=visibleMap.get(b.dataset.copy);if(i)copyItemsForChat([i]);else showToast('That revision item is no longer available.')});
}

$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
$$('[data-reader-act]').forEach(b=>b.addEventListener('click',async()=>{
  if(state.route!=='reader'||!state.bookId)return;
  document.body.classList.remove('mobile-tools-open');
  if(b.dataset.readerAct==='start'){ startSpeechFromSelection(); return; }
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
setupMediaSession();
fileInput.addEventListener('change',e=>{importFile(e.target.files[0]);e.target.value=''});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredPrompt=e;$('#installBtn').classList.remove('hidden')});
$('#installBtn').onclick=async()=>{if(state.deferredPrompt){state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null;$('#installBtn').classList.add('hidden')}};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state.isSpeaking)requestWakeLock()});
window.addEventListener('hashchange',()=>{if(db&&extractHandoffCode(location.href))processHandoffFromLocation()});
// Do not cancel speech merely because iOS backgrounds the installed app.
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

openDB().then(async()=>{ await migrateLegacyPassageAnchors(); const p=prefs(); state.bookId=p.lastBookId||null; if(state.bookId){ const b=await idbGet('books',state.bookId); if(b){ state.chapterIndex=b.progress?.chapterIndex ?? p.lastChapterIndex ?? 0; state.selectedParagraph=b.progress?.paragraphIndex ?? p.lastParagraphIndex ?? 0; state.selectedCharOffset=b.progress?.charOffset ?? p.lastCharOffset ?? 0; state.selectedWordEnd=b.progress?.wordEnd ?? p.lastWordEnd ?? 0; } } await navigate('library'); await processHandoffFromLocation(); }).catch(e=>{view.innerHTML=`<div class="empty">Storyline could not start: ${escapeHtml(e.message)}</div>`});
})();