'use strict';
// Aqua's upstream extension still expects the old Madara data-id. The site now
// serves its chapter list directly; use it only when that extension fails.
const cheerio=require('cheerio');
const {fetchText}=require('../http');
function localUrl(value,base){const url=new URL(value,base);if(url.protocol!=='https:'||url.hostname!=='aquareader.org')throw Error('Invalid Aqua Manga URL.');return url.href}
async function series(ref,source){
 const url=localUrl(ref.id,'https://aquareader.org');const $=cheerio.load(await fetchText(url));
 const title=$('.aqua-series-info__title').first().text().trim();if(!title)throw Error('Could not load this series from Aqua Manga.');
 const chapters=$('.aqua-ch-list a.aqua-ch-item').toArray().map(el=>{const a=$(el),link=localUrl(a.attr('href'),url),name=a.find('.aqua-ch-item__name').text().trim(),n=name.match(/(?:chapter|ch\.?)[\s#]*(\d+(?:\.\d+)?)/i);return{source,id:link,url:link,name,number:n?Number(n[1]):null}}).reverse();
 return {source,id:new URL(url).pathname,title,url,coverUrl:$('.aqua-series-cover__img').attr('src')||null,description:$('.aqua-series-synopsis').text().trim(),authors:$('.aqua-series-info__creator-value').toArray().map(x=>$(x).text().trim()).filter(Boolean),tags:$('.aqua-series-genre-pill').toArray().map(x=>$(x).text().trim()).filter(Boolean),status:$('.aqua-info-row__label').filter((_,x)=>$(x).text().trim()==='Status').first().next().text().trim(),chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)||null};
}
async function pages(chapter){const url=localUrl(chapter.url||chapter.id,'https://aquareader.org');const $=cheerio.load(await fetchText(url));const images=$('.reading-content img.wp-manga-chapter-img').toArray().map(el=>$(el).attr('data-src')||$(el).attr('src')).filter(Boolean).map(u=>new URL(u.trim(),url).href);if(!images.length)throw Error('No pages found for this chapter.');return{images,referer:url}}
module.exports={series,pages,supports:error=>/missing manga id/i.test(error?.message||''),supportsChapter:chapter=>/^https:\/\/aquareader\.org\//i.test(String(chapter.url||chapter.id))};
