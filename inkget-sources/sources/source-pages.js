'use strict';
// Repack fixed-size upstream pages without dropping results when Inkget asks for
// a different page size. Bounded state and serialized requests prevent repeats.
module.exports=function createPaged(fetchPage){
 const states=new Map();return async function searchPage(query='',options={}){
  const page=Math.max(1,Math.floor(Number(options.page)||1)),limit=Math.min(100,Math.max(1,Math.floor(Number(options.limit)||24))),tags=Array.isArray(options.tags)?options.tags:[],key=JSON.stringify([query,tags,options.language||'',limit]);let s=states.get(key);
  if(!s||Date.now()-s.at>600000){s={at:Date.now(),next:1,done:false,pending:[],pages:[],seen:new Set(),lock:Promise.resolve()};states.set(key,s);if(states.size>20)states.delete(states.keys().next().value)}
  s.lock=s.lock.catch(()=>{}).then(async()=>{while(s.pages.length<page&&(!s.done||s.pending.length)){let scanned=0;while(s.pending.length<limit&&!s.done&&scanned++<5){const p=await fetchPage(query,{...options,page:s.next,limit:100});s.next++;for(const x of p.items)if(!s.seen.has(x.id)){s.seen.add(x.id);s.pending.push(x)}s.done=!p.hasMore;}if(s.pending.length)s.pages.push(s.pending.splice(0,limit));else if(!s.done){s.pages.push([]);break;}}});await s.lock;return{items:s.pages[page-1]||[],hasMore:page<s.pages.length||s.pending.length>0||!s.done};
 };
};
