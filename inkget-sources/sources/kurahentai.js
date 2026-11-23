'use strict';
const cheerio = require('cheerio');
const { fetchText } = require('../http');
const BASE = 'https://kurahentai.com';
// Public publishable key used by the site's own browser client, not a user credential.
const REST = 'https://ikqewfksewzgnkcvtvor.supabase.co/rest/v1/';
const PUBLIC_KEY = 'sb_publishable_wUsGyZzpiMfbcsk5IrYYSw_zIqZ56ds';
const id = 'kurahentai';
let vocabulary = null;
async function api(table, params) {
  const url = new URL(table, REST);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  const text = await fetchText(url.href,{headers:{apikey:PUBLIC_KEY,Accept:'application/json'},retries:1});
  const data = JSON.parse(text); if (!Array.isArray(data)) throw new Error('KuraHentai returned an invalid response.'); return data;
}
function parseInput(text = '') {
  let url; try { url = new URL(text); } catch { return null; }
  if (!/(^|\.)kurahentai\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/gallery\/(\d+)\/?$/);
  return match ? { type:'series',source:id,id:match[1],url:`${BASE}/gallery/${match[1]}` } : null;
}
async function tags() {
  if (vocabulary) return vocabulary;
  const all = [];
  for (let offset=0; offset<100000; offset+=1000) {
    const rows = await api('tags',{select:'id,name,kind',kind:'eq.tag',order:'name.asc',offset,limit:1000});
    all.push(...rows.map(x=>({name:x.name,slug:x.name,count:null}))); if(rows.length<1000) break;
  }
  vocabulary = all; return all;
}
async function searchPage(query, {limit=24,tags: wanted=[],page=1,language='english'} = {}) {
  const filters = [...new Set(wanted.map(x=>String(x).trim()).filter(Boolean))];
  if (language && language !== 'any') filters.push(String(language).toLowerCase());
  if (filters.length > 12) throw new Error('KuraHentai supports up to 12 simultaneous filters.');
  const ids=[];
  for (const name of filters) {
    const found=await api('tags',{select:'id,name',name:`eq.${name}`,limit:1});
    if (!found.length) return {items:[],hasMore:false};
    ids.push(found[0].id);
  }
  const select=['id','full_title','cover_url','num_pages','favorites'];
  const params={order:'uploaded_at.desc',offset:(Math.max(1,Number(page)||1)-1)*limit,limit:Math.min(100,Math.max(1,limit))+1};
  ids.forEach((tagId,index)=>{const alias=`facet${index}`;select.push(`${alias}:hentai_tags!inner(tag_id)`);params[`${alias}.tag_id`]=`eq.${tagId}`;});
  params.select=select.join(',');
  if(query) params.full_title=`ilike.*${String(query).replace(/[*,%]/g,' ')}*`;
  const rows=await api('hentai',params);
  return {items:rows.slice(0,limit).map(row=>({source:id,id:String(row.id),title:row.full_title,url:`${BASE}/gallery/${row.id}`,coverUrl:row.cover_url,chapterCount:1,adultContent:'Yes',tags:[],pages:row.num_pages})),hasMore:rows.length>limit};
}
async function search(query,options) {return (await searchPage(query,options)).items;}
async function gallery(ref) {
  const galleryId=String(ref.id||'').match(/^\d+$/)?.[0] || parseInput(ref.url || '')?.id;
  if (!galleryId) throw new Error('Invalid KuraHentai gallery.');
  const url=`${BASE}/gallery/${galleryId}`;
  const $=cheerio.load(await fetchText(url));
  let data=null;
  $('script[type="application/ld+json"]').each((_,s)=>{
    try {const json=JSON.parse($(s).html());const list=Array.isArray(json)?json:[json];data ||= list.find(x=>x['@type']==='ImageGallery')||null;}catch{}
  });
  if(!data) throw new Error('KuraHentai did not return gallery metadata.');
  const pages=(data.associatedMedia||[]).map(x=>x.contentUrl).filter(url=>{try{return new URL(url).hostname==='hentai.shadowabyss.com';}catch{return false;}});
  const names=$('a[href^="/tag/"]').map((_,a)=>$(a).text().trim()).get().filter(Boolean);
  return {galleryId,url,data,pages,names};
}
async function getSeries(ref={}) {
  const g=await gallery(ref);
  const chapter={source:id,id:g.galleryId,name:'Gallery',number:1,url:g.url,pages:g.pages.length};
  return {source:id,id:g.galleryId,title:g.data.name,url:g.url,coverUrl:g.data.image,description:'',tags:g.names,authors:[],adultContent:'Yes',chapters:[chapter],chapterCount:1,latestChapter:chapter};
}
async function getChapterImages(chapter={}) {
  const g=await gallery(chapter);
  if(!g.pages.length) throw new Error('KuraHentai did not return accessible gallery pages.');
  return {images:g.pages,referer:`${BASE}/`};
}
async function trending({limit=24}={}) {return (await searchPage('',{limit})).items;}
module.exports={id,label:'KuraHentai',short:'KH',homepage:BASE,hosts:['kurahentai.com'],hasTags:true,parseInput,search,searchPage,tags,getSeries,getChapterImages,trending,recommendations:trending};
