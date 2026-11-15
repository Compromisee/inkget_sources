'use strict';

/**
 * Toonkotsu — a ToonX lookalike with a public catalogue.
 *
 *   GET /manga/browse                      the popular shelf (48 titles)
 *   GET /tag/<Name>                        a collection page (48 titles + its neighbours)
 *   GET /title/<slug>                      one series: cover, metadata, every tag, every chapter
 *   GET /title/<slug>/<chapterId>-chapter-N   the chapter (the reader itself is client-side)
 *
 * Two things about this site shape everything below.
 *
 * 1. **It is behind Cloudflare.** A browser that has not solved the challenge
 *    gets a "verify you are human" page, and the app's HTTP layer gets the same
 *    wall for the JSON reader endpoints. The HTML pages, however, are served
 *    server-side to a plain request, and they carry everything worth having.
 * 2. **Its API wants an account.** `/api/v1/state` answers `not signed in`, and
 *    the page images are fetched by the client from those endpoints. So the
 *    catalogue — search, tags, series, chapter lists — works here, while the
 *    pages themselves are opened in the reader window (the same route Manga18
 *    uses) instead of being scraped.
 *
 * The site is hidden by default: it joins the sources behind the Settings
 * gesture, like the adult sites.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { cleanTagName, isUsableTag } = require('./tag-utils');

const BASE = 'https://toonkotsu.com';
const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * The site serves its HTML to a browser-shaped request and challenges anything
 * that looks like a script, so every fetch here says what a browser says.
 */
const HEADERS = {
  'User-Agent': BROWSER,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${BASE}/`,
};

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 20;

/**
 * A Cloudflare wall is not a per-request accident: once the connection is
 * challenged, every request will be too. Remember that for a few minutes so the
 * wall, the tags and a search do not each pay for their own timeout.
 */
let blockedUntil = 0;

async function page(path) {
  if (Date.now() < blockedUntil) throw new Error('Toonkotsu is challenging this connection right now.');
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.html;
  let html;
  try {
    html = await fetchText(url, { headers: HEADERS });
  } catch (error) {
    if (/cloudflare|blocking the app/i.test(error.message)) blockedUntil = Date.now() + 1000 * 60 * 5;
    throw error;
  }
  cache.set(url, { at: Date.now(), html });
  if (cache.size > 120) cache.delete(cache.keys().next().value);
  return html;
}

/* ------------------------------------------------------------------ ids -- */

/** `/title/hhimlm-solo-leveling` -> `hhimlm-solo-leveling`. */
const slugFromUrl = (url = '') => String(url).match(/\/title\/([a-z0-9-]+)/i)?.[1] || null;

/** `/title/<slug>/1897633-chapter-232` -> `1897633`. */
const chapterIdFromUrl = (url = '') => String(url).match(/\/title\/[a-z0-9-]+\/(\d{3,})/i)?.[1] || null;

function parseInput(text = '') {
  const value = String(text).trim();
  const match = value.match(/toonkotsu\.com\/title\/([a-z0-9-]+)(?:\/(\d{3,})-([a-z0-9-]+))?/i);
  if (!match) return null;
  const slug = match[1];
  if (match[2]) {
    return {
      type: 'chapter',
      source: 'toonkotsu',
      id: `${slug}.${match[2]}`,
      slug,
      url: `${BASE}/title/${slug}/${match[2]}-${match[3] || 'chapter'}`,
    };
  }
  return { type: 'series', source: 'toonkotsu', id: slug, slug, url: `${BASE}/title/${slug}` };
}

/* ---------------------------------------------------------------- items -- */

const titleCase = (value) => String(value || '').replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());

/** A cover path is site-relative and lives on the CDN path the site serves. */
const coverOf = (src) => {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  return `${BASE}${src.startsWith('/') ? '' : '/'}${src}`;
};

/** The chapter number from `Chapter 232`, `Vol. 22`, or the URL tail. */
function chapterNumberFromName(name = '', url = '') {
  const value = String(name || '');
  const chapter = value.match(/chapter\s*([\d.]+)/i)?.[1];
  if (chapter && Number.isFinite(Number(chapter))) return Number(chapter);
  const volume = value.match(/vol(?:ume)?\.?\s*([\d.]+)/i)?.[1];
  if (volume && Number.isFinite(Number(volume))) return Number(volume);
  const fromUrl = String(url).match(/-chapter-([\d.]+)/i)?.[1];
  if (fromUrl && Number.isFinite(Number(fromUrl))) return Number(fromUrl);
  return null;
}

/* ------------------------------------------------------------- parsing -- */

/** The landing-style lists (`/manga/browse`, `/tag/<Name>`) are title links only. */
function cardsFromHtml(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $('a[href^="/title/"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) return;
    const title = $(element).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    const image = $(element).find('img').first();
    seen.add(slug);
    items.push({
      source: 'toonkotsu',
      id: slug,
      slug,
      title,
      url: `${BASE}/title/${slug}`,
      coverUrl: coverOf(image.attr('src') || image.attr('data-src') || null),
      type: null,
      status: null,
      year: null,
      tags: [],
    });
  });
  return items;
}

/** One title page: metadata, tags, and every chapter the site lists. */
function seriesFromHtml(html, ref = {}) {
  const $ = cheerio.load(html);
  const slug = slugFromUrl(ref.url) || String(ref.slug || ref.id || '');
  const heading = $('.ui-heading');

  const title = heading.find('h1').first().text().trim() || String(ref.title || '').trim();
  const cover = heading.find('img.ui-cover').first().attr('src') || null;

  const meta = new Map();
  heading.find('dt').each((_, element) => {
    const label = $(element).text().trim().toLowerCase();
    const value = $(element).next('dd');
    meta.set(label, value);
  });

  const authors = (meta.get('author')?.find('a').map((_, link) => $(link).text().trim()).get() || []).filter(Boolean);
  const tags = (meta.get('genres and tags')?.find('a').map((_, link) => cleanTagName($(link).text())).get() || [])
    .filter((name) => name && isUsableTag(name));

  const chapters = [];
  $('#chapters .ui-chapters li').each((_, element) => {
    const link = $(element).find('a').first();
    const href = link.attr('href') || '';
    const name = link.text().replace(/\s+/g, ' ').trim();
    const id = $(element).attr('data-chapter-id') || chapterIdFromUrl(href);
    if (!id || !name) return;
    chapters.push({
      source: 'toonkotsu',
      id: `${slug}.${id}`,
      name,
      number: chapterNumberFromName(name, href),
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      official: false,
      publishedAt: null,
      pages: null,
    });
  });
  chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const description =
    $('p.ui-description').first().text().replace(/\s+/g, ' ').trim() ||
    // The JSON-LD block is complete even when the visible copy is trimmed.
    (html.match(/"@type":"ComicSeries"[\s\S]{0,4000}?"description":"((?:[^"\\]|\\.)*)"/)?.[1] || '')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .trim();

  const associatedNames = $('section')
    .filter((_, section) => /alternative titles/i.test($(section).find('h2').text() || ''))
    .find('li')
    .map((_, item) => $(item).text().trim())
    .get()
    .filter(Boolean);

  noteTags(tags);

  return {
    source: 'toonkotsu',
    id: slug,
    slug,
    title: title || slug,
    url: `${BASE}/title/${slug}`,
    coverUrl: coverOf(cover),
    description: description.slice(0, 1200),
    authors: authors.slice(0, 8),
    artists: [],
    associatedNames: associatedNames.slice(0, 12),
    type: titleCase(meta.get('type')?.text().trim() || ''),
    status: meta.get('status')?.text().trim() || null,
    released: Number(meta.get('year')?.text().trim()) || null,
    year: Number(meta.get('year')?.text().trim()) || null,
    tags: [...new Set(tags)].slice(0, 40),
    genres: [...new Set(tags)].slice(0, 12),
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: 'Unknown',
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------- search -- */

/**
 * The site publishes no keyword search endpoint — `/search` redirects to the
 * static browse shelf — so a query is matched against the shelves the app can
 * see: the browse list, then the tag collections the query itself names
 * ("romance", "action") and the tag pages of every title it already knows.
 *
 * Results are therefore real titles with real pages, ranked by how well the
 * query matches the title; nothing is invented.
 */
const shelfCache = new Map();
const SHELF_TTL = 1000 * 60 * 30;

async function shelf(tag = null) {
  const key = tag ? `tag:${tag.toLowerCase()}` : 'browse';
  const hit = shelfCache.get(key);
  if (hit && Date.now() - hit.at < SHELF_TTL) return hit.items;
  const path = tag ? `/tag/${encodeURIComponent(tag)}` : '/manga/browse';
  let items = [];
  try {
    items = cardsFromHtml(await page(path));
  } catch {
    items = [];
  }
  shelfCache.set(key, { at: Date.now(), items });
  // The shelf is a page of links; the covers live on the title pages. The
  // first batch is looked up so the wall has something to draw, four at a
  // time, and cached with the shelf.
  if (!tag && items.length) enrichShelf(items.slice(0, 16)).catch(() => null);
  return items;
}

/** Fill in covers (and the type/year) for a few shelf rows, in place. */
async function enrichShelf(items) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item || item.coverUrl) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const html = await page(`/title/${item.slug}`);
        const full = seriesFromHtml(html, { slug: item.slug, url: `${BASE}/title/${item.slug}` });
        item.coverUrl = full.coverUrl;
        item.type = full.type;
        item.year = full.year;
        item.tags = full.tags.slice(0, 8);
      } catch {
        /* leave it as a text row */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return items;
}

const scoreTitle = (needle, title) => {
  const haystack = String(title).toLowerCase();
  const query = String(needle).toLowerCase().trim();
  if (!query) return 0;
  if (haystack === query) return 1;
  if (haystack.startsWith(query)) return 0.9;
  if (haystack.includes(query)) return 0.75;
  const words = query.split(/\s+/).filter(Boolean);
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits ? 0.35 + (hits / words.length) * 0.3 : 0;
};

async function searchPage(query, { limit = 24, tags: wanted = [], page: pageNo = 1 } = {}) {
  const text = String(query || '').trim();

  // A query that names a collection browses that collection.
  const tagShelf = text ? await shelf(text) : [];
  const base = await shelf();
  const pool = new Map();
  [...base, ...tagShelf].forEach((item) => pool.set(item.id, item));

  // Tags: the site's collections, one page each, so "action + romance" can be
  // intersected instead of the first tag winning.
  if (wanted.length) {
    const perTag = await Promise.all(wanted.map((tag) => shelf(tag)));
    const intersection = perTag.reduce((acc, list) => {
      const ids = new Set(list.map((item) => item.id));
      return acc.filter((item) => ids.has(item.id));
    }, perTag[0] || []);
    pool.clear();
    intersection.forEach((item) => pool.set(item.id, item));
    if (!text) {
      const list = intersection;
      return { items: list.slice((pageNo - 1) * limit, pageNo * limit), hasMore: list.length > pageNo * limit };
    }
  }

  const ranked = [...pool.values()]
    .map((item) => ({ item, score: scoreTitle(text, item.title) }))
    .filter((row) => (text ? row.score > 0 : true))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);

  return {
    items: ranked.slice((pageNo - 1) * limit, pageNo * limit),
    hasMore: ranked.length > pageNo * limit,
  };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* ----------------------------------------------------------------- tags -- */

let tagCache = null;

/**
 * Every tag any parsed title page has shown. The site publishes no directory,
 * but the titles the app already reads carry their full tag lists, so the
 * vocabulary builds itself from pages that were going to be fetched anyway.
 */
const seenTags = new Map();

const noteTags = (names) => {
  names.forEach((raw) => {
    const name = cleanTagName(raw);
    if (!name || !isUsableTag(name)) return;
    if (!seenTags.has(name.toLowerCase())) seenTags.set(name.toLowerCase(), { name, slug: encodeURIComponent(name) });
  });
};

/**
 * The vocabulary is not published as a directory, so it is harvested from the
 * collections the site links to plus the tag lists on the titles it shows:
 * "Genres and tags" on a title page names everything that title carries.
 */
async function tags() {
  if (tagCache) return tagCache;
  const names = new Map();

  const add = (raw) => {
    const name = cleanTagName(raw);
    if (!name || !isUsableTag(name)) return;
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), { name, slug: encodeURIComponent(name) });
  };

  // The shelf's own enrichment reads sixteen title pages with four workers;
  // each of those records its tags above, which is where most of this comes
  // from. Give it a moment to land before reading the result.
  const shelves = await Promise.all([shelf(), shelf('Action')].map((entry) => entry.catch(() => [])));
  const titles = [];
  const seen = new Set();
  shelves.flat().forEach((item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    titles.push(item);
  });

  // The collections themselves.
  await Promise.all(
    ['Action', 'Romance', 'Drama', 'Fantasy'].map(async (tag) => {
      try {
        const html = await page(`/tag/${encodeURIComponent(tag)}`);
        const $ = cheerio.load(html);
        $('nav[aria-label*="Related"] a[href^="/tag/"]').each((_, link) => {
          const href = $(link).attr('href') || '';
          add(decodeURIComponent(href.replace('/tag/', '')));
        });
      } catch {
        /* the shelf still gives what it gives */
      }
    }),
  );

  // A handful of title pages carry the full per-title tag list.
  const sample = titles.slice(0, 4);
  for (const item of sample) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const html = await page(`/title/${item.slug}`);
      const $ = cheerio.load(html);
      $('a[href^="/tag/"]').each((_, link) => add(decodeURIComponent(($(link).attr('href') || '').replace('/tag/', ''))));
    } catch {
      /* skip */
    }
  }

  seenTags.forEach((entry, key) => {
    if (!names.has(key)) names.set(key, entry);
  });

  tagCache = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  return tagCache;
}

/* --------------------------------------------------------------- series -- */

async function getSeries(ref = {}) {
  const slug = String(ref.slug || '').trim() || slugFromUrl(ref.url) || String(ref.id || '');
  if (!slug) throw new Error('That is not a Toonkotsu link.');
  const html = await page(`/title/${slug}`);
  const series = seriesFromHtml(html, { ...ref, slug });
  if (series.title === slug && !series.chapters.length) throw new Error('Toonkotsu did not return that series.');

  // The chapter list is paginated a hundred at a time (`?page=2#chapters`).
  // 235 chapters is three pages, so the rest are read here rather than leaving
  // a download short.
  const pages = Number((html.match(/Chapters\s*\((\d+)\)/i) || [])[1]) || series.chapterCount || 0;
  const perPage = Math.max(1, series.chapters.length);
  const wanted = Math.min(12, Math.ceil(pages / perPage) || 1);
  if (wanted > 1) {
    const rest = await Promise.all(
      Array.from({ length: wanted - 1 }, (_, index) =>
        page(`/title/${slug}?page=${index + 2}`).catch(() => ''),
      ),
    );
    const seen = new Set(series.chapters.map((chapter) => chapter.id));
    rest.forEach((extra) => {
      if (!extra) return;
      seriesFromHtml(extra, { ...ref, slug }).chapters.forEach((chapter) => {
        if (seen.has(chapter.id)) return;
        seen.add(chapter.id);
        series.chapters.push(chapter);
      });
    });
    series.chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    series.chapterCount = series.chapters.length;
    series.latestChapter = series.chapters[series.chapters.length - 1] || null;
  }
  return series;
}

/**
 * Pages are not in the HTML.
 *
 * The reader is a client app: it asks the site's own `/api/v1/*` endpoints for
 * the page list, and those answer `not signed in` to anything but a signed-in
 * browser (and Cloudflare challenges scripted browsers before that). Rather
 * than pretend, this says so, and the app's reader window — which is a real
 * browser on the real site — is where the chapter opens.
 */
async function getChapterImages(chapter = {}) {
  const error = new Error(
    'Toonkotsu page extraction is not yet supported. Open this chapter on the source.',
  );
  error.needsWindow = true;
  error.url = chapter.url || null;
  throw error;
}

/* ------------------------------------------------------------ the shelf -- */

async function trending({ limit = 24 } = {}) {
  const items = await shelf();
  return items.slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  const items = await shelf();
  // Not a ranking, so shake it up rather than repeat the wall.
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
}

module.exports = {
  id: 'toonkotsu',
  label: 'Toonkotsu',
  short: 'TKS',
  homepage: BASE,
  hosts: ['toonkotsu.com'],
  hidden: true,
  hasTags: true,
  needsWindow: true,
  parseInput,
  slugFromUrl,
  chapterIdFromUrl,
  chapterNumberFromName,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  trending,
  recommendations,
};
