(() => {
'use strict';

const META_KEY='storyline.sync.v1';
const LIBRARY_RECORD='storyline-library-v1';
const PROGRESS_RECORD='storyline-progress-v1';

function meta(){try{return JSON.parse(localStorage.getItem(META_KEY)||'{}')}catch{return{}}}
function saveMeta(patch){localStorage.setItem(META_KEY,JSON.stringify({...meta(),...patch}))}
function field(record,name){return record&&record.fields&&record.fields[name]?record.fields[name].value:null}
function stamp(record){return Number(field(record,'updatedAt')||(record&&record.modified&&record.modified.timestamp)||0)}
function errorText(e){return (e&&(e.reason||e.message||e.serverErrorCode))||String(e||'CloudKit error')}
function notFound(e){return /UNKNOWN_ITEM|NOT_FOUND|not found|does not exist/i.test(errorText(e))}
function assetUrl(asset){const u=asset&&asset.downloadURL||'';return u?u.replace('${f}',encodeURIComponent('storyline-library.json')):''}

window.StorylineCloudSync={
  create(adapter){
    const s={container:null,db:null,user:null,ready:false,busy:false,conflict:null,progressTimer:null,libraryTimer:null};

    function config(){return adapter.config?adapter.config():{}}
    function configured(){const c=config();return !!(c.enabled&&c.containerIdentifier&&c.apiToken&&window.CloudKit)}
    function status(msg,kind){if(adapter.onStatus)adapter.onStatus(msg,kind||'')}
    async function fetchRecord(name){
      const r=await s.db.fetchRecords(name);
      if(r&&r.records&&r.records.length)return r.records[0];
      if(r&&r.hasErrors){const e=r.errors&&r.errors[0];if(notFound(e))return null;throw e||new Error('CloudKit fetch failed')}
      return null;
    }
    async function saveRecord(name,type,fields,existing){
      const record=existing?{...existing,fields:{...(existing.fields||{}),...fields}}:{recordName:name,recordType:type,fields};
      const r=await s.db.saveRecords(record);
      if(r&&r.hasErrors)throw (r.errors&&r.errors[0])||new Error('CloudKit save failed');
      return r&&r.records&&r.records[0]||record;
    }
    async function pushLibrary(existing){
      const payload=await adapter.getLibrary();
      const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
      if(blob.size>48*1024*1024)throw new Error('The iCloud library is too large to sync safely. Export a backup and remove large voice notes.');
      const now=Date.now();
      const record=await saveRecord(LIBRARY_RECORD,'StorylineLibrary',{
        payload:{value:blob},updatedAt:{value:now},deviceID:{value:adapter.deviceId()},schemaVersion:{value:1}
      },existing||null);
      saveMeta({lastServerLibraryAt:stamp(record)||now,lastLibraryPushAt:Date.now(),libraryDirtyAt:0});
      return record;
    }
    async function pullLibrary(record){
      const url=assetUrl(field(record,'payload'));if(!url)throw new Error('The iCloud library has no downloadable payload.');
      const response=await fetch(url);if(!response.ok)throw new Error('The iCloud library could not be downloaded.');
      const payload=JSON.parse(await response.text());
      await adapter.applyLibrary(payload);
      const at=stamp(record);
      saveMeta({lastServerLibraryAt:at,lastLibraryPullAt:Date.now(),lastLibraryPushAt:Date.now(),libraryDirtyAt:0});
    }
    async function pushProgress(existing){
      const payload=await adapter.getProgress(),now=Date.now();
      const record=await saveRecord(PROGRESS_RECORD,'StorylineProgress',{
        payload:{value:JSON.stringify(payload)},updatedAt:{value:now},deviceID:{value:adapter.deviceId()},schemaVersion:{value:1}
      },existing||null);
      saveMeta({lastServerProgressAt:stamp(record)||now,lastProgressPushAt:Date.now(),progressDirtyAt:0});
      return record;
    }
    async function pullProgress(record){
      const raw=field(record,'payload');if(!raw)return;
      await adapter.applyProgress(JSON.parse(raw));
      saveMeta({lastServerProgressAt:stamp(record),lastProgressPullAt:Date.now()});
    }
    async function syncLibrary(opts={}){
      const count=await adapter.localBookCount(),m=meta();
      let remote=await fetchRecord(LIBRARY_RECORD);
      if(opts.forceRemote&&remote){await pullLibrary(remote);s.conflict=null;status('Downloaded the iCloud library to this device.','ok');return}
      if(opts.forceLocal){await pushLibrary(remote);s.conflict=null;status('This device is now the iCloud library copy.','ok');return}
      if(!remote){if(count){await pushLibrary(null);status('Library saved to iCloud.','ok')}return}
      if(!count){await pullLibrary(remote);status('Library restored from iCloud.','ok');return}
      const remoteAt=stamp(remote),known=Number(m.lastServerLibraryAt||0);
      const localDirty=Number(m.libraryDirtyAt||0)>Number(m.lastLibraryPushAt||0);
      if(!known){s.conflict={remote};status('Both this device and iCloud contain a library. Choose which copy to keep.','conflict');if(adapter.onConflict)adapter.onConflict(true);return}
      const remoteChanged=remoteAt>known;
      if(remoteChanged&&localDirty){s.conflict={remote};status('This device and iCloud both changed. Choose which library copy to keep.','conflict');if(adapter.onConflict)adapter.onConflict(true);return}
      if(remoteChanged){await pullLibrary(remote);status('Library updated from iCloud.','ok');return}
      if(localDirty){await pushLibrary(remote);status('Library changes synced to iCloud.','ok')}
    }
    async function syncProgress(){
      const remote=await fetchRecord(PROGRESS_RECORD);
      if(remote)await pullProgress(remote);
      const m=meta(),dirty=Number(m.progressDirtyAt||0)>Number(m.lastProgressPushAt||0);
      if(dirty||!remote)await pushProgress(remote);
    }
    async function syncNow(){
      if(!s.ready||s.busy)return;
      s.busy=true;status('Syncing with iCloud…','busy');
      try{await syncLibrary();await syncProgress();if(!s.conflict)status('iCloud sync is up to date.','ok')}
      catch(e){status('iCloud sync paused: '+errorText(e),'error')}
      finally{s.busy=false}
    }
    function markLibraryDirty(){
      saveMeta({libraryDirtyAt:Date.now()});clearTimeout(s.libraryTimer);
      s.libraryTimer=setTimeout(()=>{if(s.ready&&!s.busy)syncNow()},5000);
    }
    function markProgressDirty(){
      saveMeta({progressDirtyAt:Date.now()});clearTimeout(s.progressTimer);
      s.progressTimer=setTimeout(()=>{if(s.ready&&!s.busy)syncNow()},3500);
    }
    async function init(){
      const c=config();
      if(!c.enabled){status('Local only. iCloud sync is ready to configure.','off');return false}
      if(!window.CloudKit){status('iCloud sync could not load. Local reading still works.','error');return false}
      if(!c.containerIdentifier||!c.apiToken){status('iCloud sync needs its CloudKit container and web token.','off');return false}
      CloudKit.configure({containers:[{
        containerIdentifier:c.containerIdentifier,
        environment:c.environment==='production'?CloudKit.PRODUCTION_ENVIRONMENT:CloudKit.DEVELOPMENT_ENVIRONMENT,
        apiTokenAuth:{apiToken:c.apiToken,persist:true,signInButton:{id:'apple-sign-in-button',theme:'black'},signOutButton:{id:'apple-sign-out-button',theme:'black'}}
      }]});
      s.container=CloudKit.getDefaultContainer();s.db=s.container.privateCloudDatabase;
      try{s.user=await s.container.setUpAuth();s.ready=!!s.user}catch(e){status('iCloud setup failed: '+errorText(e),'error');return false}
      if(s.user){status('Signed in to iCloud. Checking for changes…','busy');await syncNow()}
      else status('Sign in with Apple to sync Storyline across your devices.','off');
      s.container.whenUserSignsIn().then(async u=>{s.user=u;s.ready=true;status('Signed in. Syncing Storyline…','busy');await syncNow()}).catch(()=>{});
      s.container.whenUserSignsOut().then(()=>{s.user=null;s.ready=false;status('Signed out. Storyline remains local on this device.','off')}).catch(()=>{});
      return s.ready;
    }
    async function mountAuth(){
      if(!configured()){status(config().enabled?'iCloud configuration is incomplete.':'Local only. iCloud sync is ready to configure.','off');return}
      if(!s.container){await init();return}
      try{s.user=await s.container.setUpAuth();s.ready=!!s.user;if(s.user&&!s.busy)status('iCloud sync is on.','ok')}catch{}
    }
    async function resolveRemote(){if(!s.conflict||!s.conflict.remote)return;await syncLibrary({forceRemote:true});await syncProgress();if(adapter.onConflict)adapter.onConflict(false)}
    async function resolveLocal(){await syncLibrary({forceLocal:true});await syncProgress();if(adapter.onConflict)adapter.onConflict(false)}
    return {init,mountAuth,syncNow,markLibraryDirty,markProgressDirty,resolveRemote,resolveLocal,isReady:()=>s.ready};
  }
};
})();