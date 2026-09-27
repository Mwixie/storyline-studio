const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 3_000_000;
const MAX_PARAGRAPHS = 5000;
const MAX_CHAPTER_LINKS = 300;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;

function json(res, status, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(data);
}
function fail(res, status, error) { return json(res, status, { ok: false, error }); }

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g,'');
  if (s === '::' || s === '::1') return true;
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s)) return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIP(v4) === 4 ? isPrivateIPv4(v4) : true;
  }
  return net.isIP(s) === 6;
}
function privateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { throw new Error('That is not a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only public http and https URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs containing credentials are not allowed.');
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private or local network addresses are not allowed.');
  }
  if (net.isIP(host) && privateIp(host)) throw new Error('Private or reserved network addresses are not allowed.');
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('The story site hostname could not be resolved.'); }
  if (!records.length || records.some(r => privateIp(r.address))) throw new Error('Private or reserved network addresses are not allowed.');
  u.hash = '';
  return u;
}
async function readBody(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('That page is too large for the reader service.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text,'utf8') > MAX_BYTES) throw new Error('That page is too large for the reader service.');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('That page is too large for the reader service.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchPublic(raw) {
  let current = await validateUrl(raw);
  for (let hop=0; hop<=MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; StorylineReader/1.0; +https://github.com/Mwixie/storyline-studio)',
          'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.8'
        }
      });
    } catch (e) {
      clearTimeout(timer);
      if (e?.name === 'AbortError') throw new Error('The story site took too long to respond.');
      throw new Error('The reader service could not reach the story site.');
    }
    clearTimeout(timer);
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('The story site returned an invalid redirect.');
      if (hop === MAX_REDIRECTS) throw new Error('The story site redirected too many times.');
      current = await validateUrl(new URL(location,current).toString());
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new Error('This page requires a login or blocks automated reading.');
    if (!response.ok) throw new Error('The story site returned HTTP ' + response.status + '.');
    return { response, finalUrl: current.toString(), body: await readBody(response) };
  }
  throw new Error('The story site redirected too many times.');
}

const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'—',ndash:'–',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“'};
function decodeEntities(s='') {
  return String(s).replace(/&#x([0-9a-f]+);/gi,(_,h)=>safeChar(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,d)=>safeChar(parseInt(d,10)))
    .replace(/&([a-z]+);/gi,(m,n)=>ENTITIES[String(n).toLowerCase()] ?? m);
}
function safeChar(code){ try{return String.fromCodePoint(code)}catch{return ''} }
function textOf(html='') {
  return decodeEntities(String(html).replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function stripNoise(html='') {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<(script|style|noscript|template|svg|iframe|form|select|button)\b[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(nav|header|footer|aside|figure|figcaption)\b[\s\S]*?<\/\1\s*>/gi,' ');
}
const UI_PREFIX=/^(previous|prev|next|table of contents|contents|share|subscribe|log in|sign in|continue reading|related|recommended|comments?|advertisement|read more|report)\b/i;
function isShortBoilerplate(text=''){const t=String(text).trim();return t.length<=120&&UI_PREFIX.test(t)}
function isProse(line='') {
  const t=String(line).trim();
  if (t.length < 20 || isShortBoilerplate(t)) return false;
  const words=t.split(/\s+/).filter(Boolean).length;
  if (words<4) return false;
  const letters=(t.match(/\p{L}/gu)||[]).length;
  return letters/Math.max(1,t.length) > .45;
}
function dedupe(lines){
  const out=[];for(const line of lines){if(line&&out[out.length-1]!==line)out.push(line)}return out;
}
function pParagraphs(html='') {
  return dedupe([...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(m=>textOf(m[1]||'')).filter(isProse));
}
function blockParagraphs(html='') {
  const flat=String(html)
    .replace(/<br\s*\/?>(\s*<br\s*\/?>)*/gi,'\n')
    .replace(/<\/(p|div|section|h[1-6]|li|blockquote)\s*>/gi,'\n');
  return dedupe(flat.split(/\n+/).map(textOf).filter(isProse));
}
function pickContent(html='') {
  const candidates=[...String(html).matchAll(/<(article|main|div|section)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)];
  let best='',bestScore=0;
  for(const m of candidates){
    const attrs=m[2]||'',inner=m[3]||'',text=textOf(inner);
    if(text.length<400)continue;
    let score=text.length;
    if(/(chapter|content|entry|article|story|text|reading|post-body)/i.test(attrs))score*=1.6;
    if(/(nav|menu|header|footer|sidebar|widget|advert|\bads?\b|banner|promo|comment|share|social|related|recommend)/i.test(attrs))score*=.3;
    score += ((inner.match(/<p\b/gi)||[]).length)*120;
    if(score>bestScore){bestScore=score;best=inner}
  }
  return best||html;
}
function extractWithCounts(html='') {
  const cleaned=stripNoise(html);
  const sourceP=[...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(m=>textOf(m[1]||'')).filter(t=>t&&!isShortBoilerplate(t));
  const sourceParagraphCount=sourceP.length;
  const sourceCharacterCount=sourceP.reduce((n,t)=>n+t.length,0);
  const selected=pickContent(cleaned);
  const selectedP=pParagraphs(selected);
  const selectedLines=selectedP.length>=3?selectedP:blockParagraphs(selected);
  const fullP=pParagraphs(cleaned);
  const fullLines=fullP.length>=3?fullP:blockParagraphs(cleaned);
  let lines=selectedLines, suspicious=false;
  if(fullLines.length>=10 && selectedLines.length<Math.ceil(fullLines.length*.2)){
    lines=fullLines;
  } else if(sourceParagraphCount>=20 && selectedLines.length<Math.ceil(sourceParagraphCount*.1)){
    suspicious=true;
  }
  let truncated=false,truncationReason=null;
  if(lines.length>MAX_PARAGRAPHS){
    truncated=true;truncationReason='The page exceeded the 5000-paragraph reader-service limit.';
    lines=lines.slice(0,MAX_PARAGRAPHS);
  } else if(suspicious){
    truncated=true;truncationReason='The service detected that the extracted story text may be incomplete compared with the source page.';
  }
  const returnedCharacterCount=lines.reduce((n,t)=>n+t.length,0);
  return {
    paragraphs:lines,truncated,sourceParagraphCount,returnedParagraphCount:lines.length,
    sourceCharacterCount,returnedCharacterCount,truncationReason
  };
}
function metaContent(html,key){
  const q=key.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');
  const a=new RegExp("<meta[^>]+(?:property|name)\\s*=\\s*[\"']"+q+"[\"'][^>]*content\\s*=\\s*[\"']([^\"']+)[\"']","i").exec(html);
  if(a)return decodeEntities(a[1]).trim();
  const b=new RegExp("<meta[^>]+content\\s*=\\s*[\"']([^\"']+)[\"'][^>]*(?:property|name)\\s*=\\s*[\"']"+q+"[\"']","i").exec(html);
  return b?decodeEntities(b[1]).trim():'';
}
function pageTitle(html,finalUrl){
  const og=metaContent(html,'og:title');
  const h1=textOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]||'');
  const title=textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]||'');
  return h1||og||title||new URL(finalUrl).pathname||'Online story';
}
function storyTitle(html,finalUrl,title){
  const explicit=metaContent(html,'book:title')||metaContent(html,'novel:title');
  if(explicit)return explicit;
  const parts=new URL(finalUrl).pathname.split('/').filter(Boolean);
  const idx=parts.findIndex(p=>/chapter|chap|episode/i.test(p));
  const slug=idx>0?parts[idx-1]:parts[Math.max(0,parts.length-2)];
  if(slug&&/[a-z]/i.test(slug))return slug.replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).trim();
  return title;
}
function anchors(html,baseUrl){
  const base=new URL(baseUrl),out=[];
  for(const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
    const attrs=m[1]||'',hm=/href\s*=\s*["']([^"']+)["']/i.exec(attrs);if(!hm)continue;
    let u;try{u=new URL(decodeEntities(hm[1]),base)}catch{continue}
    if(!/^https?:$/.test(u.protocol)||u.hostname!==base.hostname)continue;
    u.hash='';
    const label=textOf(m[2]||'')||textOf(/title\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]||'');
    out.push({href:u.toString(),text:label,raw:attrs});
  }
  return out;
}
function chapterNumber(value=''){const m=/chapter[-_/ ]?(\d+)/i.exec(value)||/[-_/](\d{1,5})(?:[/?#]|$)/.exec(value);return m?Number(m[1]):null}
function navLinks(list,currentUrl){
  const cur=new URL(currentUrl),curNum=chapterNumber(cur.pathname);
  let next=null,prev=null;
  const strictNext=/\bnext\s*(chapter|part|episode|section)\b/i,strictPrev=/\b(prev|previous)\s*(chapter|part|episode|section)\b/i;
  for(const a of list){
    if(a.href===currentUrl)continue;
    const hint=a.text+' '+a.raw, n=chapterNumber(new URL(a.href).pathname);
    if(!next&&(strictNext.test(hint)||/rel\s*=\s*["']next["']/i.test(a.raw)||(curNum!=null&&n===curNum+1)))next=a.href;
    if(!prev&&(strictPrev.test(hint)||/rel\s*=\s*["']prev(ious)?["']/i.test(a.raw)||(curNum!=null&&n===curNum-1)))prev=a.href;
  }
  return {next,prev};
}
function chapterLinks(list){
  const seen=new Set(),out=[];
  for(const a of list){
    if(out.length>=MAX_CHAPTER_LINKS)break;
    const path=new URL(a.href).pathname;
    if(!(/chapter|chap|\/ch\d|episode|part-\d/i.test(path)||/^chapter\b/i.test(a.text)))continue;
    if(seen.has(a.href))continue;seen.add(a.href);
    out.push({title:a.text||('Chapter '+(chapterNumber(path)||'')),url:a.href});
  }
  return out;
}

module.exports = async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept, Origin');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return fail(res,405,'Method not allowed.');
  const raw=Array.isArray(req.query?.url)?req.query.url[0]:req.query?.url;
  if(!raw)return fail(res,400,'Missing url query parameter.');
  try{
    const {response,finalUrl,body}=await fetchPublic(raw);
    const type=(response.headers.get('content-type')||'').toLowerCase();
    let extraction;
    if(type.includes('text/plain')){
      let paragraphs=String(body).split(/\n\s*\n+/).map(t=>t.replace(/\s+/g,' ').trim()).filter(isProse);
      const sourceParagraphCount=paragraphs.length,sourceCharacterCount=paragraphs.reduce((n,t)=>n+t.length,0);
      let truncated=false,truncationReason=null;
      if(paragraphs.length>MAX_PARAGRAPHS){truncated=true;truncationReason='The page exceeded the 5000-paragraph reader-service limit.';paragraphs=paragraphs.slice(0,MAX_PARAGRAPHS)}
      extraction={paragraphs,truncated,sourceParagraphCount,returnedParagraphCount:paragraphs.length,sourceCharacterCount,returnedCharacterCount:paragraphs.reduce((n,t)=>n+t.length,0),truncationReason};
    }else extraction=extractWithCounts(body);
    if(extraction.paragraphs.join(' ').length<200)throw new Error('The page did not contain enough readable story text.');
    const allAnchors=anchors(stripNoise(body),finalUrl),nav=navLinks(allAnchors,finalUrl),links=chapterLinks(allAnchors);
    const title=pageTitle(body,finalUrl);
    return json(res,200,{
      ok:true,url:finalUrl,title,storyTitle:storyTitle(body,finalUrl,title),
      paragraphs:extraction.paragraphs,nextUrl:nav.next,prevUrl:nav.prev,chapterLinks:links,
      truncated:extraction.truncated,sourceParagraphCount:extraction.sourceParagraphCount,returnedParagraphCount:extraction.returnedParagraphCount,
      sourceCharacterCount:extraction.sourceCharacterCount,returnedCharacterCount:extraction.returnedCharacterCount,truncationReason:extraction.truncationReason
    });
  }catch(e){
    return fail(res,502,e?.message||'The reader service could not read that page.');
  }
};
