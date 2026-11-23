'use strict';

const cheerio = require('cheerio');
const { fetchText } = require('../http');

/** Adapter for the matching ElfToon and Drake Scans series platforms. */
function createScanPortal({ id, label, short, homepage: base, hosts }) {
  const cleanLabel = value => String(value || '').replace(/\p{Extended_Pictographic}|[\uFE0E\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
  let facetCache = null;
  let facetAt = 0;
  const absolute = value => value ? new URL(value, `${base}/`).href : null;
  const seriesPath = url => String(url || '').match(/\/series\/comic\/([a-z0-9-]+)/i)?.[1] || null;
  const parseInput = text => {
    if (!hosts.some(host => String(text).includes(host))) return null;
    const slug = seriesPath(text);
    if (!slug) return null;
    const chapter = String(text).match(/\/chapter\/([\w.-]+)/i)?.[1];
    return chapter
      ? { type: 'chapter', source: id, id: `${slug}/${chapter}`, slug, url: `${base}/series/comic/${slug}/chapter/${chapter}` }
      : { type: 'series', source: id, id: slug, slug, url: `${base}/series/comic/${slug}` };
  };
  async function facets() {
    if (facetCache && Date.now() - facetAt < 3600000) return facetCache;
    const raw = JSON.parse(await fetchText(`${base}/api/series/facets`, { headers: { Accept: 'application/json' } }));
    if (!Array.isArray(raw.genres) || !Array.isArray(raw.tags)) throw new Error(`${label} did not return its filters.`);
    facetCache = [...raw.genres.map(x => ({ ...x, name: cleanLabel(x.name), group: 'genre' })), ...raw.tags.map(x => ({ ...x, name: cleanLabel(x.name), group: 'tag' }))];
    facetAt = Date.now();
    return facetCache;
  }
  async function tags() {
    return (await facets()).map(x => ({ name: x.name, slug: x.slug, group: x.group, count: x.count }));
  }
  function cards(html) {
    const $ = cheerio.load(html); const rows = []; const seen = new Set();
    $('a[href^="/series/comic/"]').each((_, a) => {
      const link = $(a), href = link.attr('href') || '';
      if (/\/chapter\//.test(href)) return;
      const image = link.find('img').first();
      const slug = seriesPath(href), title = (image.attr('alt') || link.text()).trim();
      if (!slug || !title || seen.has(slug)) return;
      let cover = image.attr('src') || image.attr('data-src') || null;
      if (cover && cover.startsWith('/_next/image?')) cover = new URL(cover, base).searchParams.get('url') || cover;
      seen.add(slug); rows.push({ source: id, id: slug, slug, title, url: `${base}/series/comic/${slug}`, coverUrl: absolute(cover), tags: [] });
    });
    return rows;
  }
  async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const size = Math.max(1, Math.min(100, Number(limit) || 24));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const sourcePage = Math.floor(offset / 24) + 1;
    const withinPage = offset % 24;
    if (sourcePage > 1) params.set('page', String(sourcePage));
    if (wanted.length) {
      const available = await facets();
      for (const group of ['genre', 'tag']) {
        const matches = wanted.map(w => available.find(f => f.group === group && [f.name, f.slug].some(v => String(v).toLowerCase() === String(w).toLowerCase()))).filter(Boolean);
        if (matches.length) params.set(group, matches.map(f => f.slug).join(','));
      }
      if (wanted.some(w => !available.some(f => [f.name, f.slug].some(v => String(v).toLowerCase() === String(w).toLowerCase())))) return { items: [], hasMore: false };
    }
    const html = await fetchText(`${base}/series?${params}`);
    const all = cards(html);
    if (withinPage + size > all.length && all.length === 24) {
      params.set('page', String(sourcePage + 1));
      all.push(...cards(await fetchText(`${base}/series?${params}`)));
    }
    return { items: all.slice(withinPage, withinPage + size), hasMore: all.length > withinPage + size || (all.length >= 24 && all.length === withinPage + size) };
  }
  async function search(query, options) { return (await searchPage(query, options)).items; }
  async function getSeries(ref = {}) {
    const slug = seriesPath(ref.url) || String(ref.slug || ref.id || '').split('/')[0];
    if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error(`Not a ${label} series link.`);
    const url = `${base}/series/comic/${slug}`;
    const $ = cheerio.load(await fetchText(url));
    const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content');
    if (!title) throw new Error(`${label} did not return a series.`);
    // Social-preview images are often title cards, not covers. The actual poster
    // is the series image whose alt text matches the heading; unwrap Next's URL.
    const poster = $('img').filter((_, img) => $(img).attr('alt')?.trim() === title).first();
    let cover = poster.attr('data-src') || poster.attr('src') || ref.coverUrl || $('meta[property="og:image"]').attr('content') || null;
    if (cover && cover.includes('/_next/image?')) cover = new URL(cover, base).searchParams.get('url') || cover;
    const chapters = [], seen = new Set(), visited = new Set(), pending = [1];
    while (pending.length) {
      const page = pending.shift();
      if (visited.has(page)) continue;
      if (visited.size >= 100) throw new Error(`${label} has too many chapter pages to load safely.`);
      visited.add(page);
      const current = page === 1 ? $ : cheerio.load(await fetchText(`${url}?page=${page}`));
      current('a[href*="/chapter/"]').each((_, el) => {
        const href = current(el).attr('href') || ''; const match = href.match(/\/chapter\/([\w.-]+)/i);
        if (!match || seriesPath(href) !== slug || seen.has(match[1])) return;
        seen.add(match[1]); const number = Number(match[1]);
        const text = current(el).text().trim();
        chapters.push({ source: id, id: `${slug}/${match[1]}`, url: absolute(href), name: /^start reading$/i.test(text) ? `Chapter ${match[1]}` : (text || `Chapter ${match[1]}`), number: Number.isFinite(number) ? number : null });
      });
      current('a[href*="page="]').each((_, el) => {
        let link; try { link = new URL(current(el).attr('href'), base); } catch { return; }
        const n = Number(link.searchParams.get('page'));
        if (link.origin === new URL(base).origin && link.pathname.replace(/\/$/, '') === new URL(url).pathname && Number.isInteger(n) && n > 0 && n <= 100 && !visited.has(n) && !pending.includes(n)) pending.push(n);
      });
    }
    chapters.sort((a,b) => (a.number || 0) - (b.number || 0));
    const genres = [...new Set($('a[href^="/genres/"]').map((_,a) => cleanLabel($(a).text())).get().filter(Boolean))];
    return { source: id, id: slug, slug, title, url, coverUrl: absolute(cover), description: $('meta[name="description"]').attr('content') || '', authors: [], tags: genres, chapters, chapterCount: chapters.length, latestChapter: chapters.at(-1) || null };
  }
  async function getChapterImages(chapter = {}) {
    if (!chapter.url || !hosts.some(host => { try { const h = new URL(chapter.url).hostname; return h === host || h.endsWith(`.${host}`); } catch { return false; } })) throw new Error(`Invalid ${label} chapter URL.`);
    const html = await fetchText(chapter.url);
    // React Flight serializes its payload inside a JavaScript string. Decode the
    // JSON argument first so escaped quotes and signed query strings are intact.
    const $ = cheerio.load(html), chunks = [];
    $('script:not([src])').each((_, el) => {
      const match = ($(el).html() || '').trim().match(/^self\.__next_f\.push\((.*)\)\s*;?$/s);
      if (!match) return;
      try { const payload = JSON.parse(match[1]); if (typeof payload[1] === 'string') chunks.push(payload[1]); } catch { /* ignore other scripts */ }
    });
    const pages = [];
    for (const chunk of chunks) {
      const marker = /"pages"\s*:\s*\[/g; let match;
      while ((match = marker.exec(chunk))) {
        const start = chunk.indexOf('[', match.index), slice = chunk.slice(start);
        let depth = 0, inString = false, escaped = false, end = -1;
        for (let i = 0; i < slice.length; i++) {
          const c = slice[i];
          if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
          if (c === '"') inString = true; else if (c === '[') depth++; else if (c === ']' && --depth === 0) { end = i + 1; break; }
        }
        if (end < 0) continue;
        try { const parsed = JSON.parse(slice.slice(0, end)); if (Array.isArray(parsed)) pages.push(...parsed.filter(p => p && typeof p === 'object' && 'imageUrl' in p)); } catch { /* incomplete Flight record */ }
        marker.lastIndex = start + end;
      }
    }
    if (pages.some(p => p.isEncrypted || p.isRedacted || p.hasStrips || p.hasFragments)) throw new Error(`${label} returned locked or encoded pages that cannot be decoded yet.`);
    const images = [...new Set(pages.map(p => p.imageUrl && absolute(p.imageUrl)).filter(Boolean))];
    if (!images.length) throw new Error(`${label} has no accessible pages for this chapter; it may be locked.`);
    return { images, referer: `${base}/` };
  }
  async function trending({ limit = 24 } = {}) { return (await searchPage('', { limit })).items; }
  return { id, label, short, homepage: base, hosts, hasTags: true, parseInput, search, searchPage, tags, getSeries, getChapterImages, trending, recommendations: trending };
}
module.exports = { createScanPortal };
