'use strict';
const cheerio = require('cheerio');
const {fetchText} = require('../http');
const {chapterNumberFromName} = require('./madara');

// Two sites use the same server-rendered catalogue, chapter and genre layouts.
function createMangaStream({id,label,short,homepage:base,hosts,seriesPath,genrePath,variant}) {
  const absolute = (url) => url ? new URL(url, base).href : null;
  const slugFrom = text => String(text || '').match(new RegExp(`${seriesPath}([a-z0-9-]+)`, 'i'))?.[1] || null;
  function parseInput(text='') {
    let u; try { u = new URL(text); } catch { return null; }
    if (!hosts.some(h=>u.hostname===h || u.hostname.endsWith(`.${h}`))) return null;
    const slug=slugFrom(u.pathname); if(!slug) return null;
    const chapter=u.pathname.match(/\/chapter-([a-z0-9.-]+)/i)?.[1];
    return chapter ? {type:'chapter',source:id,id:`${slug}/chapter-${chapter}`,slug,url:`${base}${seriesPath}${slug}/chapter-${chapter}`} : {type:'series',source:id,id:slug,slug,url:`${base}${seriesPath}${slug}`};
  }
  let tagCache;
  async function tags() {
    if(tagCache && Date.now()-tagCache.at<3600000) return tagCache.items;
    const $=cheerio.load(await fetchText(base)); const found=new Map();
    $(`a[href*="${genrePath}"]`).each((_,a)=>{const u=absolute($(a).attr('href'));let m=new URL(u).pathname.match(new RegExp(`${genrePath}([^/]+)`));let name=$(a).text().trim().replace(/\s+/g,' ');if(m&&name&&!found.has(m[1])) found.set(m[1],{name,slug:m[1]});});
    const items=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name)); if(!items.length) throw Error(`${label} did not return genres.`);tagCache={at:Date.now(),items};return items;
  }
  function cards(html) {
    const $=cheerio.load(html), seen=new Set(), items=[];
    $('.page-item-detail, .bsx, .latest-item').each((_,el)=>{
      const card=$(el); let a=card.find(`h3 a[href*="${seriesPath}"]`).first(); if(!a.length) a=card.find(`a[href*="${seriesPath}"]`).first();const slug=slugFrom(a.attr('href'));const title=(a.attr('title') || a.text()).trim().replace(/\s+/g,' ');if(!slug||!title||seen.has(slug)) return;seen.add(slug);
      const image=card.find('img').first();items.push({source:id,id:slug,slug,title,url:`${base}${seriesPath}${slug}`,coverUrl:absolute(image.attr('data-src')||image.attr('src')),tags:[]});
    }); return items;
  }
  async function getSeries(ref={}) {
    const slug=slugFrom(ref.url)||String(ref.slug||ref.id||'').split('/')[0];if(!/^[a-z0-9-]+$/i.test(slug)) throw Error(`Invalid ${label} series.`);
    const url=`${base}${seriesPath}${slug}`, $=cheerio.load(await fetchText(url));
    const title=$('h1').first().clone().children('span').remove().end().text().trim();if(!title) throw Error(`${label} did not return a series.`);
    const genres=$('.genres-content a, .main-info a[href*="/genre/"]').map((_,a)=>$(a).text().trim()).get().filter(Boolean);
    const chapters=[],seen=new Set();$('a.chapter-name[href*="/chapter-"], a[href*="/chapter-"]:has(.chapter-name)').each((_,a)=>{const href=absolute($(a).attr('href')),name=($(a).find('.chapter-name').first().text() || $(a).text()).trim();if(!href||seen.has(href))return;seen.add(href);chapters.push({source:id,id:`${slug}/${href.split('/').pop()}`,name,number:chapterNumberFromName(name),url:href,publishedAt:$(a).closest('li').find('.chapter-time').text().trim()||null});});
    chapters.sort((a,b)=>(a.number??Infinity)-(b.number??Infinity));
    return {source:id,id:slug,slug,title,url,coverUrl:absolute($('.summary_image img, .main-info-left img').first().attr('data-src')||$('.summary_image img, .main-info-left img').first().attr('src')),description:$('meta[name="description"]').attr('content')||'',authors:$('.author-content a').map((_,a)=>$(a).text().trim()).get(),tags:genres,chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)||null};
  }
  async function getChapterImages(chapter={}) {
    const u=new URL(chapter.url);if(!hosts.some(h=>u.hostname===h||u.hostname.endsWith(`.${h}`))) throw Error(`Invalid ${label} chapter URL.`);
    const $=cheerio.load(await fetchText(u.href));const images=$('.read-content img, .reading-content img').map((_,i)=>absolute($(i).attr('data-src')||$(i).attr('src'))).get().filter(Boolean);if(!images.length)throw Error(`${label} did not provide chapter pages.`);return {images:[...new Set(images)],referer:`${base}/`};
  }
  const cache=new Map();
  async function searchPage(query='',{limit=24,tags:wanted=[],page=1,language='english'}={}) {
    const vocabulary=await tags();const matched=wanted.map(w=>vocabulary.find(t=>[t.name,t.slug].some(v=>v.toLowerCase()===String(w).toLowerCase())));if(matched.some(x=>!x))return {items:[],hasMore:false};
    const text=String(query||'').trim(), size=Math.max(1,Math.min(48,Number(limit)||24)), pageNum=Math.max(1,Number(page)||1), target=pageNum*size;
    const key=JSON.stringify([text.toLowerCase(),matched.map(t=>t.slug).sort(),language]);let state=cache.get(key);if(!state||Date.now()-state.at>600000){state={at:Date.now(),items:[],next:1,done:false,lock:Promise.resolve()};cache.set(key,state);if(cache.size>30)cache.delete(cache.keys().next().value);}
    const run=async()=>{let scanned=0;while(state.items.length<target+1&&!state.done&&scanned<8){const n=state.next;scanned++;let url;
      if(text) url=variant==='buddy' ? `${base}/search/?s=${encodeURIComponent(text)}&page=${n}` : `${base}/search?q=${encodeURIComponent(text)}&page=${n}`;
      else if(matched.length) url=`${base}${genrePath}${encodeURIComponent(matched[0].slug)}${n>1?(variant==='buddy'?'/page/'+n+'/':'/'+n):''}`;
      else url=n===1?base:`${base}/page/${n}`;
      const list=cards(await fetchText(url));const lastPage=list.length<24;
      let accepted=list;
      if(matched.length> (text?0:1)) {
        accepted=[];for(let start=0;start<list.length;start+=6){const rows=await Promise.all(list.slice(start,start+6).map(item=>getSeries(item).then(detail=>({item,detail}))));for(const {item,detail} of rows){let names=new Set(detail.tags.map(t=>t.toLowerCase()));if(matched.every(t=>names.has(t.name.toLowerCase()))) accepted.push(item);}}
      }
      // Raw-language releases are excluded when English is requested.
      if(language==='english') accepted=accepted.filter(item=>!/\braw\b/i.test(item.title));
      state.items.push(...accepted); state.next++; if(lastPage)state.done=true;
    }};
    state.lock=state.lock.catch(()=>{}).then(run);await state.lock; if(state.items.length<target && !state.done) throw Error(`${label} needs a narrower search to finish this tag filter.`);return {items:state.items.slice((pageNum-1)*size,target),hasMore:state.items.length>target||!state.done};
  }
  const search=(query,opts)=>searchPage(query,opts).then(r=>r.items);
  const trending=({limit=24,language}={})=>search('',{limit,language});
  return {id,label,short,homepage:base,hosts,hasTags:true,parseInput,tags,search,searchPage,getSeries,getChapterImages,trending,recommendations:trending};
}
module.exports={createMangaStream};
