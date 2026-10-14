(() => {
'use strict';
// Build 59. This page reads the browser's own IndexedDB or a user-pasted
// clipboard copy. No manuscript content is transmitted by this script.
const $=s=>document.querySelector(s);
const SESSION_KEY='storyline.listen.tab.v1';
const PREFIX='STORYLINE_SAFARI_LISTEN_V1\n';
const MAX_CHAPTERS=5;
const message=(s)=>{$('#listenStatus').textContent=s||''};
function validateListeningCopy(value){
  if(!value||value.marker!=='storyline-safari-v1'||!Array.isArray(value.chapters))throw new Error('This is not a Storyline Safari listening copy.');
  const chapters=value.chapters.slice(0,MAX_CHAPTERS).map(c=>({
    title:String(c?.title||'Chapter').slice(0,350),
    paragraphs:Array.isArray(c?.paragraphs)?c.paragraphs.map(t=>String(t??'')).filter(t=>t.trim()):[]
  })).filter(c=>c.paragraphs.length);
  if(!chapters.length)throw new Error('The listening copy contains no readable paragraphs.');
  return {marker:'storyline-safari-v1',title:String(value.title||'Manuscript').slice(0,350),chapters};
}
function parseClipboard(text){
  const trimmed=String(text||'').trim();
  const json=trimmed.startsWith(PREFIX.trim())?trimmed.slice(PREFIX.trim().length).trimStart():trimmed;
  let value;try{value=JSON.parse(json)}catch{throw new Error('The clipboard does not contain a Storyline listening copy. Use “Copy listening chapters” in Storyline first.')}
  return validateListeningCopy(value);
}
function setView(copy,{temporary=false}={}){
  const article=$('#listeningArticle');
  const header=document.createElement('header');
  const kicker=document.createElement('p');kicker.className='listen-kicker';kicker.textContent='Storyline · Listening Edition';
  const title=document.createElement('h1');title.textContent=copy.title;
  header.append(kicker,title);
  article.replaceChildren(header);
  for(const ch of copy.chapters){
    const section=document.createElement('section');section.className='listen-chapter';
    const heading=document.createElement('h2');heading.textContent=ch.title;
    section.append(heading);
    for(const line of ch.paragraphs){
      const p=document.createElement('p');p.textContent=line;
      section.append(p);
    }
    article.append(section);
  }
  document.title=copy.title+' · Storyline Listening Edition';
  article.hidden=false;
  $('#listenHelp').hidden=true;
  $('#listenControls').hidden=false;
  $('#forgetListeningCopy').hidden=!temporary;
  $('#listenChapters').textContent=copy.chapters.length+' chapter'+(copy.chapters.length===1?'':'s')+' prepared';
  message('Your chapters are ready. Use Safari’s page menu → Listen to Page.');
}
function getSessionCopy(){
  try{
    const raw=sessionStorage.getItem(SESSION_KEY);
    return raw?validateListeningCopy(JSON.parse(raw)):null
  }catch{return null}
}
function saveSessionCopy(copy){
  try{
    sessionStorage.setItem(SESSION_KEY,JSON.stringify(copy));
    return true;
  }catch{
    return false;
  }
}
function showTransfer(messageText){
  $('#listeningArticle').hidden=true;
  $('#listenControls').hidden=true;
  $('#listenHelp').hidden=false;
  message(messageText||'Your Storyline manuscript is not available in this Safari tab.');
}
function openIndexedBook(bookId){
  return new Promise(resolve=>{
    if(!('indexedDB' in window)){resolve(null);return}
    let settled=false;
    const done=value=>{if(!settled){settled=true;resolve(value)}};
    let request;
    try{request=indexedDB.open('storyline-studio')}catch{done(null);return}
    request.onupgradeneeded=()=>{try{request.transaction.abort()}catch{};done(null)};
    request.onerror=()=>done(null);
    request.onblocked=()=>done(null);
    request.onsuccess=()=>{
      const db=request.result;
      try{
        if(!db.objectStoreNames.contains('books')){db.close();done(null);return}
        const tx=db.transaction('books','readonly'),get=tx.objectStore('books').get(bookId);
        get.onsuccess=()=>{const book=get.result||null;db.close();done(book)};
        get.onerror=()=>{db.close();done(null)};
      }catch{try{db.close()}catch{};done(null)}
    };
  });
}
function bookToCopy(book,params){
  if(!Array.isArray(book?.chapters)||!book.chapters.length)return null;
  const start=Math.max(0,Math.min(book.chapters.length-1,Number(params.get('chapter'))||0));
  const paragraph=Math.max(0,Number(params.get('paragraph'))||0);
  const count=Math.max(1,Math.min(MAX_CHAPTERS,Number(params.get('count'))||3));
  const chapters=book.chapters.slice(start,start+count).map((c,i)=>({
    title:String(c?.title||'Chapter '+(start+i+1)),
    paragraphs:Array.isArray(c?.paragraphs)?c.paragraphs.slice(i===0?paragraph:0):[]
  })).filter(c=>c.paragraphs.length);
  if(!chapters.length)return null;
  return validateListeningCopy({marker:'storyline-safari-v1',title:book.title,chapters});
}
function receiveCopy(text){
  try{
    const copy=parseClipboard(text);
    const temporary=saveSessionCopy(copy);
    setView(copy,{temporary});
    if(!temporary)message('Listening copy opened but could not be saved in this tab. Avoid refreshing the page.');
    else message('Listening copy loaded privately in this Safari tab. Use Safari’s page menu → Listen to Page.');
  }catch(error){showTransfer(error.message)}
}
async function initialize(){
  $('#pasteFromClipboard').addEventListener('click',async()=>{
    try{
      if(!navigator.clipboard?.readText)throw new Error('Automatic clipboard reading is unavailable. Use the manual paste box below.');
      const copied=await navigator.clipboard.readText();
      receiveCopy(copied);
    }catch(e){showTransfer(e.message||'Safari could not read the clipboard. Use manual paste.');$('#listenHelp details').open=true}
  });
  $('#loadManualCopy').addEventListener('click',()=>receiveCopy($('#manualListeningCopy').value));
  $('#forgetListeningCopy').addEventListener('click',()=>{
    try{sessionStorage.removeItem(SESSION_KEY)}catch{}
    const u=new URL(location.href);u.search='';history.replaceState({},'',u.toString());
    showTransfer('Listening copy forgotten from this tab. It remains in your Storyline library if imported there.');
  });
  const params=new URLSearchParams(location.search);
  const id=params.get('book');
  if(id){
    const book=await openIndexedBook(id);
    if(book){
      try{const copy=bookToCopy(book,params);if(copy){setView(copy);return}}catch(e){console.warn('Cannot prepare that chapter',e)}
    }
  }
  const session=getSessionCopy();
  if(session){setView(session,{temporary:true});return}
  showTransfer('The manuscript is not accessible in this Safari tab. Use Storyline’s copy-and-paste handoff if needed.');
}
initialize().catch(e=>{console.error(e);showTransfer('Could not prepare Safari Listening Edition. '+(e.message||''))});
})();
