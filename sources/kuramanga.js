'use strict';
const cheerio = require('cheerio');
const { fetchText } = require('../http');
const BASE = 'https://kuramanga.com';
const id = 'kuramanga';
let tagCache = null;
const absolute = url => url ? new URL(url, BASE).href : null;
function parseInput(text = '') {
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!/(^|\.)kuramanga\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/([a-z0-9-]+)(?:\/(chapter-[\d.]+))?\/?$/i);
  if (!match || ['search','about','login','terms','privacy'].includes(match[1])) return null;
  return match[2] ? {type:'chapter', source:id, id:`${match[1]}/${match[2]}`, slug:match[1], url:absolute(url.pathname)} : {type:'series', source:id, id:match[1], slug:match[1], url:absolute(`/${match[1]}`)};
}
async function tags() {
  if (tagCache) return tagCache;
  const $ = cheerio.load(await fetchText(`${BASE}/search`));
  const names = new Map();
  $('a[href*="genre="]').each((_, el) => {
    const href = $(el).attr('href');
    const name = new URL(href, BASE).searchParams.get('genre');
    if (name && !name.includes(',')) names.set(name.toLowerCase(), { name, slug:name });
  });
  if (!names.size) throw new Error('KuraManga did not return its genre list.');
  tagCache = [...names.values()].sort((a,b) => a.name.localeCompare(b.name));
  return tagCache;
}
function toItem(row) {
  return { source:id, id:row.normalized_title, slug:row.normalized_title, title:row.title, url:absolute(`/${row.normalized_title}`), coverUrl:row.thumb || null, description:row.summary || '', status:row.status || null, tags:row.genres || [], adultContent:row.is_adult ? 'Yes' : 'No', latestChapter:row.latestChapter || null };
}
async function searchPage(query, {limit = 24, tags: wanted = [], page = 1} = {}) {
  const size = Math.max(1, Math.min(100, Number(limit) || 24));
  const offset = (Math.max(1,Number(page) || 1)-1)*size;
  const upstream = Math.floor(offset/18)+1, within = offset%18;
  const params = new URLSearchParams({ajax:'1',page:String(upstream)});
  if (query) params.set('name',query);
  if (wanted.length) params.set('genre', wanted.join(','));
  const request = async p => {
    params.set('page',String(p));
    const data = JSON.parse(await fetchText(`${BASE}/search?${params}`, {headers:{'X-Requested-With':'XMLHttpRequest',Accept:'application/json'}}));
    if (!Array.isArray(data.data)) throw new Error('KuraManga search response was invalid.');
    return data;
  };
  const first = await request(upstream); const all = [...first.data];
  for (let p = upstream+1; all.length < within+size && (p-1)*18 < Number(first.total || 0); p++) all.push(...(await request(p)).data);
  return { items:all.slice(within,within+size).filter(x => x.normalized_title).map(toItem), hasMore:offset+size < Number(first.total || 0) };
}
async function search(query, options) { return (await searchPage(query, options)).items; }
async function getSeries(ref = {}) {
  const slug = String(ref.slug || ref.id || '').split('/')[0];
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error('Invalid KuraManga series.');
  const $ = cheerio.load(await fetchText(`${BASE}/${slug}`));
  const title = $('h1').first().text().trim();
  if (!title) throw new Error('KuraManga did not return that series.');
  const chapters = [], seen = new Set();
  $(`a[href^="/${slug}/chapter-"]`).each((_, a) => {
    const href = $(a).attr('href'), match = href.match(/chapter-([\d.]+)/i);
    if (!match || seen.has(match[1])) return; seen.add(match[1]);
    chapters.push({source:id,id:`${slug}/chapter-${match[1]}`,name:$(a).text().trim() || `Chapter ${match[1]}`,number:Number(match[1]),url:absolute(href)});
  });
  chapters.sort((a,b)=>a.number-b.number);
  const genres = [...new Set($('.genre-list a[href*="genre="]').map((_,a) => new URL($(a).attr('href'),BASE).searchParams.get('genre')).get().filter(Boolean))];
  const cover = $('meta[property="og:image"]').attr('content') || $('img[src*="/cover/"]').first().attr('src');
  return {source:id,id:slug,slug,title,url:absolute(`/${slug}`),coverUrl:absolute(cover),description:$('meta[name="description"]').attr('content') || '',authors:[],tags:genres,chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)||null};
}
async function getChapterImages(chapter = {}) {
  const parsed = parseInput(chapter.url);
  if (!parsed || parsed.type !== 'chapter') throw new Error('Invalid KuraManga chapter URL.');
  const $ = cheerio.load(await fetchText(parsed.url));
  const images = $('img[src*="/chapters/"]').map((_, img) => absolute($(img).attr('src'))).get();
  if (!images.length) throw new Error('No accessible KuraManga pages were returned.');
  return {images:[...new Set(images)],referer:`${BASE}/`};
}
async function trending({limit=24} = {}) { return (await searchPage('',{limit})).items; }
module.exports = {id,label:'KuraManga',short:'KM',homepage:BASE,hosts:['kuramanga.com'],hasTags:true,parseInput,tags,search,searchPage,getSeries,getChapterImages,trending,recommendations:trending};
