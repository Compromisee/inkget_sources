'use strict';

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const BASE = 'https://mangakatana.com';

const seriesIdFromUrl = (url = '') => String(url).match(/\/manga\/([a-z0-9-]+)\.(\d+)/i)?.[1] ? String(String(url).match(/\/manga\/([a-z0-9-]+)\.(\d+)/i)[2]) : null;
const slugFromUrl = (url = '') => String(url).match(/\/manga\/([a-z0-9-]+)\.(\d+)/i)?.[1] || null;
const chapterTokenFromUrl = (url = '') => String(url).match(/\/(c[\d.]+(?:-[\d.]+)?)\/?$/i)?.[1] || null;

function chapterNumberFromName(name = '', url = '') {
  const fromName = String(name).match(/chapter\s*([\d.]+)/i)?.[1];
  if (fromName) {
    const value = Number(fromName);
    if (Number.isFinite(value)) return value;
  }
  const token = chapterTokenFromUrl(url);
  const fromToken = token?.match(/c([\d.]+)/i)?.[1];
  if (fromToken) {
    const value = Number(fromToken);
    if (Number.isFinite(value)) return value;
  }
  const numbers = String(name).match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  const value = Number(numbers[numbers.length - 1]);
  return Number.isFinite(value) ? value : null;
}

function parseInput(text = '') {
  const value = String(text).trim();
  const match = value.match(/\/manga\/([a-z0-9-]+)\.(\d+)(?:\/(c[\d.]+(?:-[\d.]+)?))?/i);
  if (!match) return null;
  const id = match[2];
  const slug = match[1];
  const chapterToken = match[3] || null;
  if (chapterToken) return { type: 'chapter', source: 'mangakatana', id: `${slug}.${id}/${chapterToken}`, url: `${BASE}${match[0]}` };
  return { type: 'series', source: 'mangakatana', id, slug, url: `${BASE}/manga/${slug}.${id}` };
}

function absolute(url, base = BASE) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * MangaKatana lazy-loads covers: the first few cards use `src`, the rest only
 * carry `lazy-src` (and sometimes a `picture > source[srcset]`). Check them all.
 */
function coverFrom($, scope) {
  const image = scope.find('img').first();
  const fromImg =
    image.attr('src') || image.attr('lazy-src') || image.attr('data-src') || image.attr('data-original') || '';
  if (fromImg && !/^data:image\//i.test(fromImg)) return absolute(fromImg);

  const srcset = scope.find('source[srcset]').first().attr('srcset') || scope.find('img').first().attr('srcset');
  if (srcset) {
    const first = srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)[0];
    if (first) return absolute(first);
  }
  return null;
}


/* ---------------------------------------------------------------- tags -- */

let tagCache = null;

/** Genre navigation is on every page; scrape it once an hour. */
async function tags() {
  if (tagCache && Date.now() - tagCache.at < 60 * 60 * 1000) return tagCache.tags;
  const html = await fetchText(BASE);
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/genre/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const slug = href.match(/\/genre\/([a-z0-9-]+)/i)?.[1];
    if (!slug || seen.has(slug)) return;
    const label = ($(anchor).attr('title') || $(anchor).text() || slug).trim();
    if (!label || /^(genre|genres)$/i.test(label)) return;
    seen.set(slug, { name: label, slug });
  });
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  tagCache = { at: Date.now(), tags: list };
  return list;
}

const tagsFor = (names = []) => {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  return [...wanted];
};

/** Does this card carry at least one of the requested tags? */
const matchesTags = (itemTags = [], names = []) => {
  if (!names.length) return true;
  const have = new Set(itemTags.map((tag) => String(tag).toLowerCase()));
  return names.some((name) => have.has(String(name).toLowerCase()));
};

/**
 * Genre landing pages give a full page of tagged titles without a text query.
 * Cards there carry numeric genre ids instead of genre links, so several tags are
 * combined by intersecting the pages rather than re-filtering the results.
 */
async function browseTags(names = []) {
  const list = await tags();
  const matches = names
    .map(
      (name) =>
        list.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase()) ||
        list.find((entry) => entry.slug === String(name).toLowerCase()),
    )
    .filter(Boolean);
  if (!matches.length) return [];

  const pages = await Promise.all(
    matches.map((entry) => fetchText(`${BASE}/genre/${entry.slug}`).then(parseSearch).catch(() => [])),
  );
  if (pages.length === 1) return pages[0];

  const [first, ...rest] = pages;
  const keep = rest.map((page) => new Set(page.map((item) => item.id)));
  return first.filter((item) => keep.every((ids) => ids.has(item.id)));
}

function parseSearch(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('.item').each((_, element) => {
    const item = $(element);
    const link = item.find('h3.title a').first();
    const href = link.attr('href') || item.find('a[href*="/manga/"]').first().attr('href') || '';
    const id = seriesIdFromUrl(href);
    // Genre pages repeat a card when a series matches twice.
    if (!id || seen.has(id)) return;
    seen.add(id);

    const image = item.find('img').first();
    const status = item.find('.status').first().text().trim().replace(/\s+/g, ' ');
    const latest = item.find('.chapter a').last().text().trim();
    const tags = item
      .find('.genres a')
      .map((__, anchor) => $(anchor).text().trim())
      .get()
      .filter(Boolean);

    results.push({
      source: 'mangakatana',
      id,
      title: (link.text().trim() || link.attr('title') || (image.attr('alt') || '').replace(/\[Cover\]/gi, '') || 'Untitled').trim(),
      slug: slugFromUrl(href),
      url: absolute(href),
      coverUrl: coverFrom($, item),
      type: 'Manga',
      year: null,
      status: status || null,
      tags,
      latestChapter: latest || null,
    });
  });

  return results;
}

const searchCache = new Map();
const SEARCH_TTL = 60 * 1000;

/**
 * One page of results. MangaKatana pages by path: `/page/<n>/?search=...`.
 * A tag-only browse reads whole genre pages, so it has no further pages.
 */
async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const text = String(query || '').trim();
  const selected = tagsFor(wanted);

  if (!text && selected.length) {
    const all = await search(query, { limit: 1000, tags: wanted });
    const start = Math.max(0, (page - 1) * limit);
    return { items: all.slice(start, start + limit), hasMore: false };
  }

  const results = await runSearch(query, page);
  const filtered = selected.length ? results.filter((item) => matchesTags(item.tags, selected)) : results;
  return { items: filtered.slice(0, limit), hasMore: results.length >= limit };
}

async function search(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const selected = tagsFor(wanted);
  const key = `${String(query || '').trim().toLowerCase()}::${selected.sort().join('|')}::${page}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.results;

  let results;
  if (!String(query || '').trim() && selected.length) {
    // No text: browse the genre pages directly (already filtered by the site).
    results = await browseTags(selected);
  } else {
    results = await runSearch(query, page);
    if (selected.length) results = results.filter((item) => matchesTags(item.tags, selected));
  }

  const sliced = results.slice(0, limit);
  searchCache.set(key, { at: Date.now(), results: sliced });
  if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value);
  return sliced;
}

async function runSearch(query, page = 1) {
  const term = encodeURIComponent(String(query || '').trim());
  const prefix = page > 1 ? `${BASE}/page/${page}` : BASE;
  const response = await fetchText(`${prefix}/?search=${term}&search_by=book_name`, { as: 'response' });
  assertAvailable(response.text);

  // A single exact match redirects straight to the series page.
  if (/\/manga\/[^/?#]+\.[0-9]+/i.test(response.url)) {
    const $ = cheerio.load(response.text);
    const id = seriesIdFromUrl(response.url);
    const image = $('meta[property="og:image"]').attr('content');
    const title =
      $('h1.heading').first().text().trim() || $('title').text().split('|')[0].replace(/Manga\s*$/i, '').trim();
    if (!id) return [];
    return [
      {
        source: 'mangakatana',
        id,
        title: title || 'Untitled',
        slug: slugFromUrl(response.url),
        url: response.url,
        coverUrl: absolute(image),
        type: 'Manga',
        year: null,
        status: $('.value.status').first().text().trim() || null,
        tags: $('.genres a')
          .map((_, anchor) => $(anchor).text().trim())
          .get()
          .slice(0, 6),
      },
    ];
  }

  return parseSearch(response.text);
}

function parseChapters($) {
  const chapters = [];
  const seen = new Set();

  $('.chapters table tr, .chapters .chapter').each((_, element) => {
    const row = $(element);
    const anchor = row.is('a') ? row : row.find('a[href*="/manga/"]').first();
    const href = anchor.attr('href') || '';
    if (!href) return;
    const name = anchor.text().trim();
    if (!name || seen.has(href)) return;
    seen.add(href);

    chapters.push({
      source: 'mangakatana',
      id: chapterTokenFromUrl(href) || href,
      name,
      number: chapterNumberFromName(name, href),
      url: absolute(href),
      official: false,
      publishedAt: row.find('.update_time').first().text().trim() || null,
    });
  });

  chapters.sort((a, b) => {
    if (a.number == null && b.number == null) return 0;
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number;
  });

  return chapters;
}

/**
 * The site swaps every page for a one-line "scheduled maintenance" notice while
 * it works on itself. Reporting that beats handing back an empty grid.
 */
function assertAvailable(html) {
  if (/scheduled maintenance|Sorry for the inconvenience/i.test(html) && html.length < 2000) {
    throw new Error('MangaKatana is down for scheduled maintenance. Try again later.');
  }
  return html;
}

async function getSeries(ref) {
  const url = ref.url || (ref.slug ? `${BASE}/manga/${ref.slug}.${ref.id}` : null);
  if (!url) throw new Error('That is not a MangaKatana series link.');

  const html = assertAvailable(await fetchText(url));
  const $ = cheerio.load(html);

  const title = $('h1.heading').first().text().trim() || $('title').text().split('|')[0].replace(/Manga\s*$/i, '').trim();
  const description = ($('meta[property="og:description"]').attr('content') || $('.summary').first().text() || '')
    .replace(/^summary:\s*/i, '')
    .trim();

  const authors = $('.authors a, .author')
    .map((_, anchor) => $(anchor).text().trim())
    .get()
    .filter(Boolean);

  // Scope to the series meta block: the site also renders a full genre menu elsewhere.
  const tags = [
    ...new Set(
      $('ul.meta .genres a, ul.meta .value .genres a')
        .map((_, anchor) => $(anchor).text().trim())
        .get()
        .filter(Boolean),
    ),
  ].slice(0, 12);

  const associatedNames = $('.alt_name')
    .map((_, node) => $(node).text().trim())
    .get()
    .filter(Boolean);

  const chapters = parseChapters($);

  return {
    source: 'mangakatana',
    id: ref.id || seriesIdFromUrl(url),
    slug: slugFromUrl(url),
    title,
    url: absolute(url),
    coverUrl: absolute($('meta[property="og:image"]').attr('content')),
    description,
    authors,
    tags,
    associatedNames,
    type: 'Manga',
    status: $('.value.status').first().text().trim() || null,
    // MangaKatana has no "released" field; the last-update year is the closest signal.
    released: ($('.value.updateAt').first().text().match(/\b(19|20)\d{2}\b/) || [])[0] || null,
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: tags.some((tag) => /adult|mature|smut|erotica|ecchi|yaoi|yuri/i.test(tag)) ? 'Yes' : 'No',
    related: [],
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getChapterImages(chapter) {
  const html = await fetchText(chapter.url);
  const images = [];

  // MangaKatana ships the page list inside inline JS arrays.
  const arrayMatches = html.match(/(?:thzq|ytaw)\s*=\s*\[([\s\S]*?)\]/g) || [];
  for (const block of arrayMatches) {
    const urls = block.match(/'([^']+\.(?:jpe?g|png|webp|avif|gif)[^']*)'|"([^"]+\.(?:jpe?g|png|webp|avif|gif)[^"]*)"/gi) || [];
    for (const entry of urls) {
      const url = entry.replace(/^['"]|['"]$/g, '');
      if (!images.includes(url)) images.push(url);
    }
  }

  if (!images.length) {
    const $ = cheerio.load(html);
    $('#page img, .imgs img, img[data-src*="mangakatana"]').each((_, element) => {
      const src = $(element).attr('data-src') || $(element).attr('src');
      if (src) images.push(absolute(src));
    });
  }

  if (!images.length) throw new Error('No pages found for this chapter.');
  return { images, referer: `${BASE}/` };
}

async function recommendations({ limit = 12 } = {}) {
  const html = await fetchText(BASE);
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('.item').each((_, element) => {
    const item = $(element);
    const link = item.find('h3.title a').first();
    const href = link.attr('href') || '';
    const id = seriesIdFromUrl(href);
    if (!id || seen.has(id)) return;

    const image = item.find('img').first();
    const title = (link.text().trim() || (image.attr('alt') || '').replace(/\[Cover\]/gi, '') || '').trim();
    if (!title) return;
    seen.add(id);

    results.push({
      source: 'mangakatana',
      id,
      title,
      slug: slugFromUrl(href),
      url: absolute(href),
      coverUrl: coverFrom($, item),
      type: 'Manga',
      year: null,
      status: item.find('.status').first().text().trim().replace(/\s+/g, ' ') || null,
      tags: [],
    });
  });

  return results.slice(0, limit);
}

/** Trending: the site's most-viewed listing (same card markup as search). */
async function trending({ limit = 24 } = {}) {
  const html = await fetchText(`${BASE}/?filter=1&sort=views`);
  const results = parseSearch(html);
  return results.slice(0, limit);
}

async function resolveChapter(chapter) { return {url: chapter.url}; }

module.exports = {
  resolveChapter,
  id: 'mangakatana',
  label: 'MangaKatana',
  short: 'MK',
  homepage: BASE,
  hosts: ['mangakatana.com'],
  parseInput,
  seriesIdFromUrl,
  slugFromUrl,
  chapterTokenFromUrl,
  chapterNumberFromName,
  hasTags: true,
  search,
  searchPage,
  getSeries,
  getChapterImages,
  recommendations,
  trending,
  tags,
};
