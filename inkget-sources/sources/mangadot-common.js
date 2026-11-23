'use strict';
// MangaDot's JSON API and server-rendered reader data. The two catalogues
// intentionally share no mutable adult preference or browser-local state.
const { fetchText } = require('../http');
const BASE = 'https://mangadot.net';
const blockedTags = ['Sexual Content', 'Erotica', 'Sexual Acts', 'Oral Intercourse', 'Anal Intercourse', 'Group Intercourse', 'Public Intercourse', 'Borderline H'];
function languageCode(value) { const v=String(value||'en').toLowerCase(); return ({english:'en',japanese:'ja',chinese:'zh',any:'all'})[v] || (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(v)?v:'en'); }
const blockedSet = new Set(blockedTags.map(x => x.toLowerCase()));
const headers = { Referer: BASE + '/', Accept: 'application/json, text/html, */*' };
async function request(path) { return fetchText(BASE + path, { headers }); }
async function json(path) { const data = await request(path); try { return JSON.parse(data); } catch { throw Error('MangaDot returned an unexpected response (possibly a Cloudflare challenge).'); } }
function numberId(x) { const s=String(x||''); if(!/^\d+$/.test(s)) throw Error('Invalid MangaDot ID.'); return s; }
function absolute(value) { if (!value) return null; const u=new URL(value, BASE); if(u.protocol!=='https:' || u.hostname!=='mangadot.net') throw Error('Invalid MangaDot URL.'); return u.href; }
function readerData(html) {
 const m=html.match(/streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/); if(!m) throw Error('MangaDot reader data is unavailable.');
 let a; try { a=JSON.parse(JSON.parse(m[1])); } catch { throw Error('Invalid MangaDot reader data.'); }
 const memo=new Map(); function decode(i){ if(i<0)return null; if(memo.has(i))return memo.get(i);const x=a[i]; if(Array.isArray(x)){const out=[];memo.set(i,out);for(const v of x)out.push(decode(v));return out;} if(x&&typeof x==='object'){const out={};memo.set(i,out);for(const [k,v] of Object.entries(x))out[a[Number(k.slice(1))]]=decode(v);return out;}return x; }
 const data=decode(0)?.loaderData?.['pages/ChapterReaderPage']; if(!data?.chapter)throw Error('MangaDot chapter is unavailable or requires access.');return data.chapter;
}
let vocabulary=null;
async function getVocabulary() { if(vocabulary && Date.now()-vocabulary.at<3600000)return vocabulary.value; const d=await json('/api/manga/tags?in_use=1&adult=1');if(!Array.isArray(d.categories))throw Error('MangaDot tag catalogue unavailable.');let values=[];const seen=new Set();for(const c of d.categories)for(const t of c.tags||[]){if(!t.name||seen.has(t.name.toLowerCase()))continue;seen.add(t.name.toLowerCase());values.push({name:t.name,slug:t.name,adult:t.is_adult===true});}vocabulary={at:Date.now(),value:values};return values; }
function safe(m) { if(!m || !Array.isArray(m.tags) || m.is_adult!==false || ['erotica','pornographic'].includes(String(m.content_rating||'').toLowerCase()))return false;const all=(m.tags||[]).flatMap(c=>c.tags||[]);return !all.some(t=>blockedSet.has(String(t.name||'').toLowerCase())); }
function create(adult) {
 const id=adult?'mangadot-adult':'mangadot';
 function seriesUrl(idValue){ return `${BASE}/manga/${numberId(idValue)}${adult?'?adult=1':''}`; }
 function chapterUrl(idValue,source='user'){const u=new URL('/chapter/'+numberId(idValue),BASE); if(!['user','scraped'].includes(source))throw Error('Invalid MangaDot chapter source.');u.searchParams.set('source',source);if(adult)u.searchParams.set('adult','1');return u.href;}
 function parseInput(text='') { try { const u=new URL(text);if(u.protocol!=='https:' || u.hostname!=='mangadot.net')return null;if(!adult&&u.searchParams.get('adult')==='1')return null;let m=u.pathname.match(/^\/manga\/(\d+)\/?$/);if(m)return {type:'series',source:id,id:m[1],url:seriesUrl(m[1])};m=u.pathname.match(/^\/chapter\/(\d+)\/?$/);if(m){let source=u.searchParams.get('source')||'user';if(!['user','scraped'].includes(source))return null;return {type:'chapter',source:id,id:m[1],url:chapterUrl(m[1],source)}}}catch{}return null; }
 async function tags(){return (await getVocabulary()).filter(x=>adult||(!x.adult&&!blockedSet.has(x.name.toLowerCase()))).map(({name,slug})=>({name,slug}));}
 async function detail(idValue){const d=await json('/api/manga/'+numberId(idValue));if(!d?.manga)throw Error('MangaDot series not found.');if(!adult&&!safe(d.manga))throw Error('This title is not available in the public MangaDot catalogue.');return d.manga;}
 async function searchPage(query='',options={}){
  const page=Math.max(1,Math.floor(Number(options.page)||1)),limit=Math.min(100,Math.max(1,Math.floor(Number(options.limit)||24))), selected=(Array.isArray(options.tags)?options.tags:[]).map(String);
  if(selected.some(x=>x.includes(',')||x.startsWith('-')))throw Error('Invalid MangaDot tag.');
  const p=new URLSearchParams({page:String(page),limit:String(limit),lang:languageCode(options.language),sortBy:query?'relevance':'latest',sortOrder:'desc'});if(query)p.set('search',String(query));if(adult)p.set('adult','1');else p.set('hide_adult','1');
  const filters=adult?selected:[...selected,...blockedTags.map(t=>'-'+t)];if(filters.length)p.set('tags',filters.join(','));
  const d=await json('/api/search?'+p);if(!Array.isArray(d.manga_list))throw Error('MangaDot search returned an unexpected response.');
  let candidates=d.manga_list.filter(m=>adult||(m.is_adult===false&&!['erotica','pornographic'].includes(String(m.content_rating||'').toLowerCase())));
  // Search rows omit detailed tags. Validate each public result against the
  // actual series metadata as a defence against incorrect upstream filtering.
  if(!adult){let next=0;const keep=Array(candidates.length).fill(false);await Promise.all(Array.from({length:Math.min(5,candidates.length)},async()=>{for(;;){const i=next++;if(i>=candidates.length)return;try{await detail(candidates[i].id);keep[i]=true}catch{}}}));candidates=candidates.filter((_,i)=>keep[i]);}
  const items=candidates.map(m=>({source:id,id:String(m.id),title:m.title,url:seriesUrl(m.id),coverUrl:absolute(m.photo),authors:[],tags:[]}));const pag=d.pagination||{};return {items,hasMore:!!pag.next_cursor || Number(pag.current_page||page)<Number(pag.total_pages||page)};
 }
 async function search(q,o){return (await searchPage(q,o)).items;}
 async function getSeries(ref){const mid=numberId(ref.id),m=await detail(mid);const lang=languageCode(ref.language);let rows=await json(`/api/manga/${mid}/chapters/list?lang=${encodeURIComponent(lang)}`);if(!Array.isArray(rows))throw Error('MangaDot chapter list unavailable.');rows=rows.filter(c=>(lang==='all'||String(c.language||'').toLowerCase()===lang) && ['user','scraped'].includes(c.source||'user'));const chapters=rows.map(c=>({source:id,id:String(c.id),titleId:mid,name:c.chapter_title||`Chapter ${c.chapter_number??c.id}`,number:Number(c.chapter_number)||0,url:chapterUrl(c.id,c.source||'user'),publishedAt:c.date_added||null,language:c.language,scanlator:c.group_name||c.scanlator_name||null})).sort((a,b)=>a.number-b.number);const names=x=>Array.isArray(x)?x.map(y=>typeof y==='string'?y:y.name).filter(Boolean):typeof x==='string'?[x]:[];return {source:id,id:mid,title:m.title,url:seriesUrl(mid),coverUrl:absolute(m.photo),description:m.description||'',authors:names(m.authors),tags:(m.tags||[]).flatMap(x=>(x.tags||[]).map(t=>t.name)).filter(Boolean),chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)||null};}
 async function getChapterImages(chapter){const ref=parseInput(chapter.url||'');if(ref?.type!=='chapter')throw Error('Invalid MangaDot chapter link.');const data=readerData(await fetchText(ref.url,{headers}));if(!adult){const mid=numberId(data.manga?.id||data.chapter?.manga_id);await detail(mid);}const images=(data.images||[]).map(x=>absolute(x.url)).filter(Boolean);if(!images.length)throw Error('MangaDot chapter pages unavailable or access restricted.');return {images,referer:ref.url};}
 async function resolveChapter(ref){const p=parseInput(ref.url||'');if(!p||p.type!=='chapter')throw Error('Invalid MangaDot chapter link.');const d=readerData(await fetchText(p.url,{headers}));const mid=numberId(d.manga?.id||d.chapter?.manga_id);if(!adult)await detail(mid);return {source:id,id:mid,url:seriesUrl(mid)};}
 return {id,label:adult?'MangaDot Adult':'MangaDot',short:'MD',homepage:adult?BASE+'/?adult=1':BASE+'/',hosts:['mangadot.net'],hasTags:true,exactTags:true,parseInput,tags,search,searchPage,getSeries,getChapterImages,resolveChapter,trending:({limit}={})=>search('',{limit}),recommendations:({limit}={})=>search('',{limit})};
}
module.exports={create,readerData,safe,blockedTags};
