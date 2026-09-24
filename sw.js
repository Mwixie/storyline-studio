const CACHE='storyline-v44';
const RUNTIME='storyline-runtime-v44';
const ASSETS=['./','./index.html','./styles.css?v=44','./app.js?v=44','./manifest.webmanifest','./icon.svg','./vendor/qrcode.min.js','./vendor/jsQR.js'];
const CACHEABLE_EXTERNAL_HOSTS=new Set(['cdnjs.cloudflare.com','cdn.jsdelivr.net','tessdata.projectnaptha.com']);
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>![CACHE,RUNTIME].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  const isAppAsset=url.origin===location.origin&&(e.request.mode==='navigate'||/\.(?:js|css|html)$/.test(url.pathname));
  if(isAppAsset){
    e.respondWith(fetch(e.request).then(resp=>{
      const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return resp;
    }).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
    return;
  }
  if(CACHEABLE_EXTERNAL_HOSTS.has(url.hostname)){
    e.respondWith(caches.open(RUNTIME).then(async cache=>{
      const hit=await cache.match(e.request);if(hit)return hit;
      const resp=await fetch(e.request);
      if(resp&&resp.ok)cache.put(e.request,resp.clone()).catch(()=>{});
      return resp;
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
