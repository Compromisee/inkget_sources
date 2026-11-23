'use strict';
const cheerio = require('cheerio');
const { createMadara } = require('./madara');
const BASE = 'https://manhwatop.com';
const site = createMadara({ id: 'manhwatop', label: 'ManhwaTop', short: 'MT', homepage: BASE, hosts: ['manhwatop.com'], seriesPath: '/manga/', genrePath: '/manga-genre/', genreIndexUrl: BASE, genreBlocklist: ['genres'] });
const normalSeries = site.getSeries;
site.getSeries = async ref => {
  const result = await normalSeries(ref);
  if (result.chapters.length) return result;
  const url = new URL(`${result.url.replace(/\/$/, '')}/ajax/chapters/`);
  if (url.hostname !== 'manhwatop.com') throw new Error('Invalid ManhwaTop URL.');
  let response;
  try { response = await fetch(url, {method:'POST',signal:AbortSignal.timeout(15000)}); } catch { /* try Chromium below */ }
  if (!response || !response.ok) {
    let net;
    try { net = require('electron').net; } catch { /* browser preview */ }
    if (typeof net?.fetch === 'function') response = await net.fetch(url.href,{method:'POST'});
  }
  if (!response?.ok) throw new Error('ManhwaTop blocked the chapter list. Try again in the desktop app.');
  const $ = cheerio.load(await response.text());
  const chapters = [], seen = new Set();
  $('.wp-manga-chapter a').each((_,a)=>{
    const href=$(a).attr('href'), name=$(a).text().trim();
    let u; try { u=new URL(href,BASE); } catch {return;}
    if (u.hostname !== 'manhwatop.com' || !u.pathname.startsWith(`/manga/${result.slug}/chapter-`) || seen.has(u.href)) return;
    const token=u.pathname.match(/chapter-([\d.]+)/i)?.[1]; if(!token) return;
    seen.add(u.href); chapters.push({source:'manhwatop',id:`${result.slug}/${token}`,name:name || `Chapter ${token}`,number:Number(token),url:u.href});
  });
  chapters.sort((a,b)=>a.number-b.number);
  if (!chapters.length) throw new Error('ManhwaTop returned no chapter list.');
  return {...result,chapters,chapterCount:chapters.length,latestChapter:chapters.at(-1)};
};
module.exports = site;
