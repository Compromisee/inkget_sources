'use strict';

/**
 * nhentai.to — one gallery per book, searched with namespaced tags.
 *
 *   https://nhentai.to/search?q=<tags>&page=<n>     results
 *   https://nhentai.to/g/<id>/                      one gallery
 *   https://nhentai.to/tags?page=<n>                the tag directory
 *
 * A query is space separated terms that all have to match, and the site honours
 * namespaced terms (`language:english`, `artist:...`) alongside plain tags. The
 * tag directory is browsable page by page, so the app can offer the whole
 * vocabulary instead of only what has been seen so far.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const BASE = 'https://nhentai.to';
const TAG_CACHE = 'nhentai.tags.v1';
const TAG_TTL = 1000 * 60 * 60 * 24 * 3;

let tagCache = null;

const idOf = (url = '') => String(url).match(/\/g\/(\d+)/)?.[1] || null;

/** Cards ship a 250px thumbnail; the same gallery folder holds the real cover. */
const coverOf = (src) => (src ? String(src).replace(/\/thumb\.(jpg|jpeg|webp|png)$/i, '/cover.$1') : null);

function parseInput(text = '') {
  const value = String(text).trim();
  const gallery = value.match(/nhentai\.(?:to|net)\/g\/(\d+)/i);
  if (gallery) return { type: 'series', source: 'nhentai', id: gallery[1], slug: gallery[1] };
  if (/^\d{3,9}$/.test(value)) return { type: 'series', source: 'nhentai', id: value, slug: value };
  return null;
}

/**
 * A query is the site's own: space separated terms that all have to match.
 *
 * The site's tags are un-namespaced, so an E-Hentai style `female:collar` is
 * reduced to `collar` before it is sent; a `language:` term becomes the search
 * form's own language filter instead of a tag.
 */
const LANGUAGE_OF = (text = '') => String(text).match(/language:([a-z_-]+)/i)?.[1]?.toLowerCase() || null;

function buildQuery(query, { language = 'english', tags = [] } = {}) {
  const parts = [String(query || '').trim(), ...(tags || []).map((tag) => String(tag).trim())].filter(Boolean);
  const wanted = (language && language !== 'any' ? `language:${language}` : '');
  const terms = parts
    .join(' ')
    .replace(/language:[a-z_-]+/gi, ' ')
    .replace(/\b(?:female|male|mixed|other|reclass|cosplayer|studio|artist|group|parody|character|series|circle):/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { query: terms, language: LANGUAGE_OF(parts.join(' ')) || (wanted ? language : null) };
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.gallery, div.gallery').each((_, card) => {
    const link = $(card).find('a.cover, a[href^="/g/"]').first();
    const href = link.attr('href') || '';
    const id = idOf(href);
    if (!id) return;

    const image = $(card).find('img').first();
    const caption = $(card).find('.caption').first().text().trim();
    const title = (image.attr('alt') || caption || `Gallery ${id}`).replace(/\s+/g, ' ').trim();
    const count = $(card).find('.count, .num-pages').first().text().replace(/[^\d]/g, '');

    items.push({
      source: 'nhentai',
      id,
      slug: id,
      title,
      url: `${BASE}/g/${id}/`,
      // The feed lazy-loads: `src` is often an inline base64 placeholder and
      // the real thumbnail sits in `data-src`.
      coverUrl: coverOf(
        [image.attr('data-src'), image.attr('data-original'), image.attr('src')].find(
          (value) => value && !/^data:/i.test(value),
        ),
      ),
      type: 'Gallery',
      status: null,
      year: null,
      tags: [],
      chapterCount: Number(count) || null,
      latestChapter: null,
    });
  });

  // Older/newer layouts list the same cards without the wrapper class.
  if (!items.length) {
    const seen = new Set();
    $('a[href^="/g/"]').each((_, anchor) => {
      const href = $(anchor).attr('href') || '';
      const id = idOf(href);
      if (!id || seen.has(id)) return;
      const image = $(anchor).find('img').first();
      const title = (image.attr('alt') || $(anchor).find('.caption').text() || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      seen.add(id);
      items.push({
        source: 'nhentai',
        id,
        slug: id,
        title,
        url: `${BASE}/g/${id}/`,
        // The feed lazy-loads: `src` is often an inline base64 placeholder and
      // the real thumbnail sits in `data-src`.
      coverUrl: coverOf(
        [image.attr('data-src'), image.attr('data-original'), image.attr('src')].find(
          (value) => value && !/^data:/i.test(value),
        ),
      ),
        type: 'Gallery',
        status: null,
        year: null,
        tags: [],
        chapterCount: null,
        latestChapter: null,
      });
    });
  }

  return items;
}

async function searchPage(query, { limit = 24, tags = [], language = 'english', page = 1 } = {}) {
  const search = buildQuery(query, { language, tags });
  const url = new URL(`${BASE}/search`);
  url.searchParams.set('q', search.query);
  if (search.language) url.searchParams.set('lang', search.language);
  if (page > 1) url.searchParams.set('page', String(page));

  const html = await fetchText(url.toString(), { headers: { Cookie: 'nw=1' } });
  const all = parseCards(html);
  const items = all.slice(0, limit);
  const hasNext = /href="[^"]*page=[^"]*"/i.test(html) || all.length >= limit;
  return { items, hasMore: hasNext };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* --------------------------------------------------------------- tags -- */

/**
 * The whole directory, walked page by page.
 *
 * Each directory page lists a few hundred tags with their counts; the loop stops
 * when a page adds nothing new, and the result is cached for three days.
 */
async function tags() {
  if (tagCache) return tagCache;
  try {
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs/promises');
    const raw = JSON.parse(await fs.readFile(path.join(os.tmpdir(), `${TAG_CACHE}.json`), 'utf8'));
    if (raw && Date.now() - raw.at < TAG_TTL && Array.isArray(raw.items) && raw.items.length > 200) {
      tagCache = raw.items;
      return tagCache;
    }
  } catch {
    /* First run. */
  }

  const seen = new Map();
  let last = 120;
  for (let page = 1; page <= last; page += 1) {
    let html;
    try {
      html = await fetchText(`${BASE}/tags?page=${page}`, { headers: { Cookie: 'nw=1' } });
    } catch {
      break;
    }
    const $ = cheerio.load(html);
    // The letter nav links the final page, so the walk knows when to stop.
    const hint = Math.max(0, ...[...html.matchAll(/\?page=(\d+)#/g)].map((match) => Number(match[1])));
    if (hint) last = Math.min(last, hint);
    let added = 0;
    $('a[href^="/tag/"]').each((_, anchor) => {
      const slug = String($(anchor).attr('href') || '').replace(/^\/tag\//, '').replace(/\/$/, '');
      const name = $(anchor).find('.name').first().text().trim() || $(anchor).text().replace(/\s+/g, ' ').trim();
      const count = Number(($(anchor).find('.count').first().text() || '').replace(/[^\d]/g, '')) || null;
      if (!slug || !name || seen.has(slug)) return;
      added += 1;
      seen.set(slug, { name: name.replace(/\s+\d+$/, ''), slug, count });
    });
    if (!added) break;
  }

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length) {
    tagCache = list;
    try {
      const path = require('node:path');
      const os = require('node:os');
      const fs = require('node:fs/promises');
      await fs.writeFile(path.join(os.tmpdir(), `${TAG_CACHE}.json`), JSON.stringify({ at: Date.now(), items: list }), 'utf8');
    } catch {
      /* Caching is an optimisation. */
    }
  }
  return list;
}

/* ------------------------------------------------------------- series -- */

/** The gallery's own blocks: "Tags", "Pages", "Languages", "Artists", … */
function readSections($) {
  const out = {};
  $('.tag-container').each((_, block) => {
    const label = $(block)
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .replace(/[:\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!label) return;
    const values = $(block)
      .find('a.tag, a[href^="/tag/"]')
      .map((__, anchor) => $(anchor).find('.name').first().text().trim() || $(anchor).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);
    if (values.length) out[label] = values;
  });
  return out;
}

async function getSeries(ref = {}) {
  const id = idOf(ref.url || '') || String(ref.id || ref.slug || '').match(/\d{3,9}/)?.[0];
  if (!id) throw new Error('That is not an nhentai gallery link.');

  const url = `${BASE}/g/${id}/`;
  const html = await fetchText(url, { headers: { Cookie: 'nw=1' } });
  const $ = cheerio.load(html);

  const title = ($('h1').first().text() || $('title').text() || '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('nhentai did not return that gallery.');

  const sections = readSections($);
  const pages = Number(String((sections.pages || [])[0] || '').replace(/[^\d]/g, '')) ||
    Number(HTMLPageCount(html)) ||
    0;
  const languages = sections.languages || [];
  // "translated" says a translation exists, not which language; prefer the real one.
  const language = languages.find((value) => value !== 'translated') || languages[0] || null;
  const tags = [
    ...(sections.tags || []).map((tag) => tag.toLowerCase()),
    ...(sections.parodies || []).map((tag) => `parody:${tag.toLowerCase()}`),
    ...(sections.characters || []).map((tag) => `character:${tag.toLowerCase()}`),
    ...(sections.artists || []).map((tag) => `artist:${tag.toLowerCase()}`),
    ...(sections.groups || []).map((tag) => `group:${tag.toLowerCase()}`),
    ...(sections.categories || []).map((tag) => tag.toLowerCase()),
  ];
  const cover = $('img').map((__, img) => $(img).attr('src')).get().find((src) => /\/cover\.(jpg|webp|png)$/i.test(src || '')) ||
    $('a[href^="/g/"] img').first().attr('src') ||
    null;

  return {
    source: 'nhentai',
    id,
    slug: id,
    title,
    url,
    coverUrl: cover,
    type: 'Gallery',
    status: null,
    released: null,
    description: '',
    authors: sections.artists || [],
    associatedNames: [],
    tags: [...new Set(tags)].slice(0, 16),
    language,
    adultContent: 'Yes',
    downloadName: title.replace(/[[\]]/g, '').slice(0, 80),
    chapters: pages
      ? [{ source: 'nhentai', id, name: `${pages} pages`, number: 1, url, official: false, publishedAt: null, pages }]
      : [],
    chapterCount: pages ? 1 : 0,
    latestChapter: null,
    fetchedAt: new Date().toISOString(),
  };
}

const HTMLPageCount = (html) => html.match(/Pages:?[\s\S]{0,200}?<span class="name">(\d+)<\/span>/)?.[1] || '';

/**
 * Every page of a gallery.
 *
 * The gallery page already lists one thumbnail per page; the full image is the
 * same file without the `t` suffix, so no extra request is needed to discover
 * them.
 */
async function getChapterImages(chapter = {}) {
  const id = idOf(chapter.url || '') || String(chapter.id || '');
  if (!id) throw new Error('That is not an nhentai gallery link.');

  const url = `${BASE}/g/${id}/`;
  const html = await fetchText(url, { headers: { Cookie: 'nw=1' } });

  const thumbs = [...new Set([...html.matchAll(/https:\/\/[^"'\s]+\/galleries\/\d+\/\d+t\.(?:jpg|webp|png)/g)].map((match) => match[0]))];
  const images = thumbs
    .map((thumb) => thumb.replace(/(\d+)t\.(jpg|webp|png)$/i, '$1.$2'))
    .filter((src, index, list) => list.indexOf(src) === index);

  if (!images.length) throw new Error('No pages found for this gallery.');
  return { images, referer: url };
}

async function trending({ limit = 24 } = {}) {
  // The root page is a splash screen now; `/home/` is the gallery feed.
  const html = await fetchText(`${BASE}/home/`, { headers: { Cookie: 'nw=1' } });
  return parseCards(html).slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  return trending({ limit });
}

module.exports = {
  id: 'nhentai',
  label: 'nhentai',
  short: 'NH',
  homepage: BASE,
  hosts: ['nhentai.to', 'nhentai.net'],
  hasTags: true,
  parseInput,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  trending,
  recommendations,
};
