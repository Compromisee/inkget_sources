'use strict';

/**
 * WebtoonClub — server-rendered Next.js pages.
 *
 *   /webtoons?sort=popular&page=N     catalogue
 *   /search?q=<query>&page=N          search
 *   /genre/<slug>?page=N              one genre
 *   /webtoon/<slug>                   series
 *   /webtoon/<slug>/chapter/<n>       reader (page images in the HTML)
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { cleanTagName, isUsableTag, tagKey, readTagCache, writeTagCache } = require('./tag-utils');

const BASE = 'https://webtoonclub.com';

const chapterUrl = (slug, number) => `${BASE}/webtoon/${slug}/chapter/${number}`;

const seriesUrl = (slug) => `${BASE}/webtoon/${slug}`;

function absolute(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return `${BASE}${value.startsWith('/') ? '' : '/'}${value}`;
}

const slugify = (name = '') =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const slugFromUrl = (url = '') => String(url).match(/\/webtoon\/([a-z0-9-]+)/i)?.[1] || null;

function parseInput(text = '') {
  const value = String(text).trim();
  const chapter = value.match(/webtoonclub\.com\/webtoon\/([a-z0-9-]+)\/chapter\/([\d.]+)/i);
  if (chapter) {
    return {
      type: 'chapter',
      source: 'webtoonclub',
      id: `${chapter[1]}/${chapter[2]}`,
      slug: chapter[1],
      url: chapterUrl(chapter[1], chapter[2]),
    };
  }
  const series = value.match(/webtoonclub\.com\/webtoon\/([a-z0-9-]+)/i);
  if (series) {
    return { type: 'series', source: 'webtoonclub', id: series[1], slug: series[1], url: seriesUrl(series[1]) };
  }
  return null;
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('a[href^="/webtoon/"]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr('href') || '';
    // Skip chapter links: they sit inside the same cards.
    if (/\/chapter\//.test(href)) return;
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) return;

    const card = anchor.closest('article, li, div').length ? anchor.closest('article, li, div') : anchor;
    const image = card.find('img').first();
    const title =
      (anchor.attr('title') || card.find('h3, h2, .title').first().text() || image.attr('alt') || '')
        .trim()
        .replace(/\s+/g, ' ') || slug.replace(/-/g, ' ');
    if (!title) return;
    seen.add(slug);

    results.push({
      source: 'webtoonclub',
      id: slug,
      slug,
      title,
      url: seriesUrl(slug),
      coverUrl: absolute(image.attr('src') || image.attr('data-src')),
      type: 'Webtoon',
      year: null,
      status: null,
      tags: [],
      latestChapter: card.find('[class*="chapter" i]').first().text().trim() || null,
    });
  });

  return results;
}

async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const text = String(query || '').trim();
  // Genre pages are addressed by slug. A label this site does not know must not
  // turn into a 404 (or into an unfiltered listing): the request is answered
  // with nothing and the registry simply skips the source.
  let genre = '';
  if (wanted && wanted.length) {
    genre = await resolveGenre(wanted[0]);
    if (!genre) return { items: [], hasMore: false };
  }

  let url;
  if (!text && genre) {
    url = `${BASE}/genre/${encodeURIComponent(genre)}${page > 1 ? `?page=${page}` : ''}`;
  } else if (text) {
    const params = new URLSearchParams({ q: text });
    if (page > 1) params.set('page', String(page));
    url = `${BASE}/search?${params.toString()}`;
  } else {
    url = `${BASE}/webtoons?sort=popular${page > 1 ? `&page=${page}` : ''}`;
  }

  const html = await fetchText(url);
  const all = parseCards(html);
  const results = all.slice(0, limit);
  return { items: results, hasMore: all.length >= limit && new RegExp(`page=${page + 1}(?![0-9])`).test(html) };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* --------------------------------------------------------------- tags -- */

const TAG_CACHE_KEY = 'webtoonclub.tags';
let genreIndex = null;

/**
 * Genre cards print three things inside one anchor: the label, its title count
 * and a blurb. Only the label is kept.
 */
async function tags() {
  const cached = readTagCache(TAG_CACHE_KEY);
  if (cached) {
    genreIndex = cached;
    return cached;
  }

  const html = await fetchText(`${BASE}/genres`);
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href*="/genre/"]').each((_, anchor) => {
    const slug = ($(anchor).attr('href') || '').match(/\/genre\/([a-z0-9_-]+)/i)?.[1];
    if (!slug || seen.has(slug)) return;

    // Prefer an explicit label span, then the first span, then the anchor text.
    const labelled = $(anchor).find('[class*="font-semibold"]').first();
    const firstSpan = $(anchor).find('span').first();
    const raw = (labelled.length ? labelled.text() : '') || (firstSpan.length ? firstSpan.text() : '') || $(anchor).text();
    const name = cleanTagName(raw) || cleanTagName(slug.replace(/-/g, ' '));
    if (!isUsableTag(name)) return;

    seen.set(slug, { name, slug });
  });

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  genreIndex = list;
  return writeTagCache(TAG_CACHE_KEY, list);
}

/** Map a label (or an already-formed slug) onto this site's genre slug. */
async function resolveGenre(name) {
  const wanted = tagKey(name);
  if (!wanted) return '';
  const list = genreIndex || (await tags().catch(() => []));
  const hit = list.find((entry) => tagKey(entry.name) === wanted) || list.find((entry) => tagKey(entry.slug) === wanted);
  return hit ? hit.slug : '';
}

/* ------------------------------------------------------------- series -- */

/**
 * Every chapter of a series.
 *
 * The series page ships only the newest dozen chapter links (plus a "start
 * reading" one) and hides the rest behind its own expander, whose click fetches
 * `/api/comics/<comicId>/chapters`. Scraping the HTML alone therefore skipped
 * almost the whole run — a 238-chapter series came back as thirteen rows, with
 * page counts glued onto the names.
 *
 * So: read the comic id out of the page, ask the same endpoint the expander
 * asks, and fall back to the embedded flight payload (which carries a partial
 * chapter array and the true count) if that call fails.
 */
async function collectChapters($, html, slug) {
  // The Next.js payload escapes its quotes (`\"comicId\":1011070`), so read the
  // number that follows the key rather than matching a clean JSON object.
  const comicId =
    html.match(/comicId\W{0,6}(\d{2,12})/)?.[1] ||
    html.match(/\/api\/comics\/(\d+)\/chapters/)?.[1] ||
    null;

  const fromApi = comicId
    ? await fetchText(`${BASE}/api/comics/${comicId}/chapters`, { headers: { Accept: 'application/json' } })
        .then((text) => (JSON.parse(text)?.chapters || []))
        .catch(() => [])
    : [];

  const raw = fromApi.length ? fromApi : embeddedChapters(html);
  const seen = new Set();
  const chapters = [];

  for (const entry of raw) {
    const number = String(entry.chapterNumber ?? entry.number ?? '').trim();
    if (!number || !/^[\d.]+$/.test(number)) continue;
    // `223.90` from the API and `223.9` from a link are the same chapter.
    const key = String(Number(number));
    if (seen.has(key)) continue;
    seen.add(key);
    const label = entry.title ? String(entry.title).trim() : '';
    chapters.push({
      source: 'webtoonclub',
      id: String(entry.id ?? key),
      name: label || `Chapter ${Number(number)}`,
      number: Number(number),
      url: chapterUrl(slug, Number(number)),
      official: false,
      pages: Number(entry.pageCount) || null,
      publishedAt: entry.date || null,
    });
  }

  // Anything the API did not list but the page links to (a freshly posted
  // chapter, or a site without the endpoint) still belongs in the run.
  $('a[href*="/chapter/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const number = href.match(/\/chapter\/([\d.]+)/i)?.[1];
    const key = number ? String(Number(number)) : null;
    if (!key || seen.has(key)) return;
    const text = $(anchor).text().trim().replace(/\s+/g, ' ');
    // "Start reading", "Latest · Ch. 223" and friends point at a chapter but
    // are site chrome, not titles.
    const named = /^(?:start|begin|read|continue|latest|new)\b/i.test(text) ? '' : text;
    seen.add(key);
    chapters.push({
      source: 'webtoonclub',
      id: number,
      name: named || `Chapter ${Number(number)}`,
      number: Number(number),
      url: chapterUrl(slug, Number(number)),
      official: false,
      pages: null,
      publishedAt: null,
    });
  });

  chapters.sort((a, b) => a.number - b.number);
  return chapters;
}

/** The chapter array Next.js embeds in the page, used when the API is missing. */
function embeddedChapters(html) {
  const at = html.indexOf('chapterNumber');
  if (at < 0) return [];
  const start = html.lastIndexOf('[', html.lastIndexOf('chapters', at));
  if (start < 0) return [];
  // Walk to the matching bracket so the slice stays valid JSON.
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html[i] === '[') depth += 1;
    else if (html[i] === ']') {
      depth -= 1;
      if (!depth) {
        try {
          return JSON.parse(html.slice(start, i + 1).replace(/\\"/g, '"')) || [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

async function getSeries(ref = {}) {
  const slug = ref.slug || ref.id || slugFromUrl(ref.url || '');
  if (!slug) throw new Error('That is not a WebtoonClub series link.');
  const html = await fetchText(seriesUrl(slug));
  const $ = cheerio.load(html);

  const title = (
    $('h1').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    slug
  )
    .replace(/\s*\|\s*WebtoonClub\s*$/i, '')
    .trim();

  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const cover =
    $('meta[property="og:image"]').attr('content') ||
    $('img[src*="/uploads/covers/"]').first().attr('src') ||
    null;

  const genres = $('a[href^="/genre/"]')
    .map((_, anchor) => $(anchor).text().trim())
    .get()
    .filter(Boolean);

  const chapters = await collectChapters($, html, slug);

  return {
    source: 'webtoonclub',
    id: slug,
    slug,
    title,
    url: seriesUrl(slug),
    coverUrl: absolute(cover),
    description: String(description).replace(/\s+/g, ' ').slice(0, 1200),
    authors: [],
    associatedNames: [],
    tags: [...new Set(genres)].slice(0, 12),
    type: 'Webtoon',
    status: null,
    released: null,
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: $('a[href^="/genre/"]')
      .map((_, anchor) => $(anchor).text().toLowerCase())
      .get()
      .some((name) => /adult|smut|mature/.test(name))
      ? 'Yes'
      : 'No',
    related: [],
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------ chapter -- */

/**
 * A chapter's page list.
 *
 * The page only server-renders the first handful of <img> tags — the rest of a
 * forty-page chapter is hydrated from the flight payload Next.js embeds, where
 * every page appears as `{"filename":"chapters/…","width":…,"sortOrder":…}`.
 * Reading the tags alone is why a chapter used to open with five pages.
 */
function pagesFromFlight(html) {
  const found = new Map();
  const push = (filename, order) => {
    const clean = String(filename || '')
      .replace(/\\+/g, '')
      .replace(/^\/+/, '')
      .trim();
    if (!/^chapters\//i.test(clean)) return;
    if (!/\.(jpe?g|png|webp|avif|gif)$/i.test(clean)) return;
    const key = clean.toLowerCase();
    if (found.has(key)) return;
    found.set(key, { url: `${BASE}/uploads/${clean}`, order: Number(order) || 0 });
  };

  // Escaped JSON inside the RSC stream, and the same shape unescaped.
  for (const match of html.matchAll(/\\?"filename\\?":\\?"([^"\\]+)\\?"[^}]*?\\?"sortOrder\\?":(\d+)/g)) {
    push(match[1], match[2]);
  }
  for (const match of html.matchAll(/\\?"filename\\?":\\?"([^"\\]+)\\?"/g)) {
    push(match[1], 0);
  }

  return [...found.values()].sort((a, b) => a.order - b.order).map((entry) => entry.url);
}

async function getChapterImages(chapter = {}) {
  const html = await fetchText(chapter.url);
  const images = [];

  for (const url of pagesFromFlight(html)) {
    if (!images.includes(url)) images.push(url);
  }

  // Fall back to the rendered tags: an older or partial payload still has some.
  if (!images.length) {
    const $ = cheerio.load(html);
    $('img[src*="/uploads/chapters/"], img[data-src*="/uploads/chapters/"]').each((_, image) => {
      const src = ($(image).attr('src') || $(image).attr('data-src') || '').trim();
      if (!src) return;
      const url = absolute(src);
      if (url && !images.includes(url)) images.push(url);
    });
  }

  return { images, referer: `${BASE}/` };
}

/* --------------------------------------------------- trending + picks -- */

async function trending({ limit = 24 } = {}) {
  const html = await fetchText(`${BASE}/webtoons?sort=popular`);
  return parseCards(html).slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  const html = await fetchText(`${BASE}/webtoons?sort=rating`);
  return parseCards(html).slice(0, limit);
}

module.exports = {
  id: 'webtoonclub',
  label: 'WebtoonClub',
  short: 'WTC',
  homepage: BASE,
  hosts: ['webtoonclub.com'],
  hasTags: true,
  parseInput,
  slugFromUrl,
  seriesUrl,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  recommendations,
  trending,
};
