'use strict';
const cheerio=require('cheerio');const {fetchText}=require('../http');const {arraysFor}=require('./flight');
const id='baetoon',label='BaeToon',short='BAE',base='https://baetoon.com',hosts=['baetoon.com'];
const absolute=x=>x?new URL(x,base).href:null;
function parseInput(text=''){let u;try{u=new URL(text)}catch{return null}if(!hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;let s=u.pathname.match(/^\/title-detail\/([\w-]+)/);if(s)return{type:'series',source:id,id:s[1],slug:s[1],url:absolute(s[0])};let c=u.pathname.match(/^\/chapter-detail\/([\w-]+)/);return c?{type:'chapter',source:id,id:c[1],url:absolute(c[0])}:null;}
let vocabulary,at=0;async function tags(){if(vocabulary&&Date.now()-at<3600000)return vocabulary;let j=JSON.parse(await fetchText(`${base}/api/index/genres`));if(!Array.isArray(j.data))throw Error('BaeToon genres unavailable');vocabulary=j.data.filter(x=>x.name).map(x=>({name:x.name,slug:x.slug||x.name}));at=Date.now();return vocabulary;}
function card(r){let path=r.seriesHref||`/title-detail/${r.slug}-${r.id}`,slug=path.match(/\/title-detail\/([\w-]+)/)?.[1];return slug&&r.title?{source:id,id:slug,slug,title:r.title,url:absolute(path),coverUrl:r.coverNormal||r.cover,tags:r.tags||[],description:r.synopsis||'',status:r.status}:null;}
const cache=new Map();
async function searchPage(query='',{limit=24,tags:wanted=[],page=1}={}) {
  // A title search must not depend on the separate genre endpoint.
  const vocab=wanted.length ? await tags() : [];
  const chosen=wanted.map(w=>vocab.find(t=>[t.name,t.slug].some(x=>String(x).toLowerCase()===String(w).toLowerCase())));
  if(chosen.some(x=>!x))return {items:[],hasMore:false};
  const size=Math.max(1,Math.min(48,Number(limit)||24)), requested=Math.max(1,Number(page)||1);
  const key=JSON.stringify([query,chosen.map(x=>x.name).sort(),size]);
  let state=cache.get(key);
  if(!state||Date.now()-state.at>600000){state={at:Date.now(),pending:[],pages:[],next:1,done:false,lock:Promise.resolve()};cache.set(key,state);if(cache.size>30)cache.delete(cache.keys().next().value);}
  const run=async()=>{
    while(state.pages.length<requested && (!state.done||state.pending.length)) {
      let scanned=0;
      while(state.pending.length<size&&!state.done&&scanned++<15){
        const params=new URLSearchParams({sort:'lastest-updates',page:String(state.next),limit:'24'});
        if(query)params.set('text',query);if(chosen.length)params.set('tag',chosen[0].slug);
        const data=JSON.parse(await fetchText(`${base}/api/titles/search?${params}`));
        if(!Array.isArray(data.data))throw Error('BaeToon search unavailable');
        const items=data.data.map(card).filter(Boolean).filter(item=>chosen.every(t=>item.tags.some(x=>String(x).toLowerCase()===t.name.toLowerCase())));
        state.pending.push(...items);state.done=state.next>=Number(data.pagination?.totalPages||1);state.next++;
      }
      if(!state.pending.length&&!state.done)throw Error('BaeToon needs a narrower search to finish the tag filter.');
      if(state.pending.length)state.pages.push(state.pending.splice(0,size));
    }
  };
  state.lock=state.lock.catch(()=>{}).then(run);await state.lock;
  return {items:state.pages[requested-1]||[],hasMore:requested<state.pages.length||state.pending.length>0||!state.done};
}
const search=(q,o)=>searchPage(q,o).then(r=>r.items);
async function getSeries(ref={}){let slug=ref.slug||String(ref.id||'').split('/')[0]||parseInput(ref.url)?.slug;if(!/^[\w-]+$/.test(slug))throw Error('Invalid BaeToon series');let url=`${base}/title-detail/${slug}`,html=await fetchText(url),$=cheerio.load(html),title=$('h1').first().text().trim();if(!title)throw Error('BaeToon series unavailable');let groups=arraysFor(html,'chapters').filter(a=>a.some(x=>x?.href?.includes('/chapter-detail/'))),rows=groups.sort((a,b)=>b.length-a.length)[0]||[],chapters=[],seen=new Set();for(const x of rows){if(x.lang&&String(x.lang).toLowerCase()!=='en')continue;let options=Array.isArray(x.sources)&&x.sources.length?x.sources:[x];for(const source of options){if(source.lang&&String(source.lang).toLowerCase()!=='en')continue;let href=source.href||x.href,c=parseInput(absolute(href));if(!c||seen.has(c.id))continue;seen.add(c.id);chapters.push({source:id,id:c.id,name:[x.title||`Chapter ${x.number}`,source.sourceName||x.sourceName].filter(Boolean).join(' · '),number:Number(x.number)||0,url:c.url,publishedAt:x.datetime||null});}}
 chapters.sort((a,b)=>a.number-b.number);let image=$('meta[property="og:image"]').attr('content'),all=arraysFor(html,'tags').find(a=>a.length&&a.every(x=>typeof x==='string'))||[];return{source:id,id:slug,slug,title,url,coverUrl:absolute(image),description:$('meta[name="description"]').attr('content')||'',tags:all,authors:[],chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)||null};}
async function resolveChapter(chapter){let html=await fetchText(chapter.url),$=cheerio.load(html),href=$('a[href^="/title-detail/"]').first().attr('href');let parsed=href&&parseInput(absolute(href));if(!parsed)throw Error('BaeToon chapter series unavailable');return parsed;}
async function getChapterImages(chapter={}){let c=parseInput(chapter.url);if(!c||c.type!=='chapter')throw Error('Invalid BaeToon chapter');let html=await fetchText(c.url),sets=arraysFor(html,'pages').filter(x=>x.length&&x.every(u=>typeof u==='string'&&/^https?:\/\//i.test(u)));let images=sets.sort((a,b)=>b.length-a.length)[0]||[];if(!images.length)throw Error('BaeToon pages are unavailable or locked');return{images,referer:`${base}/`};}
const trending=({limit=24}={})=>search('',{limit});module.exports={id,label,short,homepage:base,hosts,hasTags:true,parseInput,tags,search,searchPage,getSeries,resolveChapter,getChapterImages,trending,recommendations:trending};
