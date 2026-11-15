'use strict';

/**
 * ToonX — a Next.js reader with two catalogues behind one domain.
 *
 *   /manga, /manhwa, /manga/<slug>     the clean catalogue (locked mode)
 *   /adult/browse, /comic/<slug>       the 18+ catalogue (unlocked mode)
 *
 * The site draws everything with React Server Components, so the useful data is
 * in the flight payload rather than the markup. Three things are worth knowing:
 *
 *  - `/manga/browse`, `/manhwa/browse`, `/manga/<slug>` and `/comic/<slug>`-style
 *    sub-routes answer 403 to any client that is not the site's own browser tab,
 *    while `/manga`, `/manhwa`, `/adult/browse`, `/genre/<slug>` and every
 *    `/api/...` route answer 200. Only the routes that work are used.
 *  - `/api/comics/<comicId>/chapters` returns the chapter list, and nothing else
 *    exposes it, so a card's numeric id is what makes a series readable. Cards
 *    carry that id in their React key.
 *  - Page images live at `/uploads/chapters/<comicId>/<chapterId>/001.ext`.
 *    The extension is not exposed anywhere (a chapter can mix `.webp` and
 *    `.jpg`), so the page URLs are found by asking for the file, not guessed
 *    from a pattern.
 *
 * The site's own `/api/search` answers `{"total":0}` to every query, so search
 * goes through the browse routes' `search=` parameter instead.
 */

const { fetchText } = require('../http');
const { cleanTagName, isUsableTag, tagKey, tagSlug, readTagCache, writeTagCache } = require('./tag-utils');

const BASE = 'https://toonx.to';
const IMG = `${BASE}/uploads`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

/* ------------------------------------------------------------------ lock -- */

/**
 * Locked mode is the clean catalogue; unlocked is the 18+ one. The app holds
 * the switch (Ctrl+L) and tells this module, so a single instance of the source
 * never has to be told twice.
 */
let locked = true;

function setLocked(next) {
  locked = Boolean(next);
  return locked;
}

const isLocked = () => locked;

/* ------------------------------------------------------------- catalogue -- */

const OPEN_PAGES = ['/manga', '/manhwa'];

/**
 * Undo the two layers of escaping the flight payload is wrapped in. The HTML
 * carries `\"` inside a JS string inside a JSON string; the structural quotes
 * come back once the runs of backslashes are collapsed.
 */
function unescapeFlight(html) {
  return String(html || '')
    .replace(/\\\\"/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&');
}

/** Split one page into its cards: React key, href, title, cover. */
function cardsFromHtml(html) {
  const text = unescapeFlight(html);
  const out = [];
  const seen = new Set();
  // Every card opens with its React key: `"div","<comicId>",{"className":"group relative"`.
  const marks = [...text.matchAll(/"div","(\d{4,9})",\{"className":"group relative"/g)];
  marks.forEach((mark, index) => {
    const start = mark.index;
    const end = index + 1 < marks.length ? marks[index + 1].index : Math.min(text.length, start + 2600);
    const body = text.slice(start, end);
    const id = mark[1];
    const href = body.match(/"href":"(\/(?:comic|manga|manhwa)\/[a-z0-9\-_.]+)"/)?.[1] || null;
    if (!href || seen.has(id)) return;
    seen.add(id);
    const cover = body.match(/"src":"(\/uploads\/covers\/[^"]+)"/)?.[1] || null;
    const slug = href.split('/').pop();
    const title =
      body.match(/"alt":"([^"]+)"/)?.[1] ||
      body.match(/,"children":"([^"]{2,120})"/)?.[1] ||
      slug.replace(/-/g, ' ');
    out.push({
      id,
      slug,
      url: `${BASE}${href}`,
      catalogue: href.startsWith('/comic/') ? 'adult' : 'clean',
      title: cleanTitle(title),
      coverUrl: cover ? `${BASE}${cover}` : null,
      coverThumb: cover ? `${BASE}${cover.replace(/\.(webp|jpg|png)$/i, '_thumb.webp')}` : null,
    });
  });
  return out;
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titles seen in a listing, so a series page can be opened from a card. */
const summaryCache = new Map();

function remember(cards) {
  cards.forEach((card) => summaryCache.set(card.id, { ...(summaryCache.get(card.id) || {}), ...card }));
  return cards;
}

/** One catalogue page, both modes. */
async function cataloguePage({ page = 1, search = '', genres = [], sort = '' } = {}) {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (search) params.set('search', search);
  if (sort) params.set('sort', sort);

  if (locked) {
    // The clean catalogue has no paged browse route that answers a plain fetch,
    // so a page is assembled from its own listings: the two front pages for a
    // browse, and the genre pages when tags are chosen. Several tags intersect,
    // which is what "both of these" means.
    let cards = [];
    if (genres.length) {
      const pages = await Promise.all(
        genres.map((slug) => fetchText(`${BASE}/genre/${slug}`, { headers: HEADERS }).catch(() => '')),
      );
      const perGenre = pages.map((html) => cardsFromHtml(html).filter((card) => card.catalogue === 'clean'));
      if (perGenre.every((list) => !list.length)) {
        // The clean catalogue's genre pages are drawn in the browser and answer a
        // plain fetch with an empty shell. Say so instead of showing "no results"
        // for a tag that would work the moment the 18+ catalogue is unlocked.
        throw new Error(
          'ToonX serves its clean-catalogue genre pages only to a browser — press Ctrl+L to browse tags on the 18+ catalogue.',
        );
      }
      const [first, ...rest] = perGenre;
      cards = (first || []).filter((card) => rest.every((list) => list.some((other) => other.id === card.id)));
    } else {
      const pages = await Promise.all(
        OPEN_PAGES.map((path) => fetchText(`${BASE}${path}`, { headers: HEADERS }).catch(() => '')),
      );
      cards = pages.flatMap((html) => cardsFromHtml(html));
    }
    if (search) {
      const needle = search.toLowerCase();
      cards = cards.filter((card) => card.title.toLowerCase().includes(needle));
    }
    const unique = [...new Map(cards.map((card) => [card.id, card])).values()];
    remember(unique);
    return { items: unique, hasMore: false, total: unique.length };
  }

  if (genres.length) params.set('genres', genres.join(','));
  const html = await fetchText(`${BASE}/adult/browse?${params.toString()}`, { headers: HEADERS });
  const cards = remember(cardsFromHtml(html).filter((card) => card.catalogue === 'adult'));
  // "10,761 titles" is printed above the grid; the pager links to page+1 when
  // there is another page.
  const total = Number(unescapeFlight(html).match(/([\d,]+)"\s*,\s*"\s*titles/)?.[1]?.replace(/,/g, '') || 0);
  const hasMore = new RegExp(`page=${page + 1}"`).test(unescapeFlight(html)) || cards.length >= 24;
  return { items: cards, hasMore, total: total || null };
}

/* ------------------------------------------------------------------ map --- */

function toItem(card) {
  return {
    source: 'toonx',
    id: String(card.id),
    title: card.title,
    url: card.url,
    coverUrl: card.coverUrl,
    type: card.catalogue === 'adult' ? 'comic' : 'manga',
    status: null,
    released: null,
    description: card.description || '',
    authors: card.authors || [],
    tags: (card.genres || []).map((genre) => genre.name || genre).filter(Boolean).slice(0, 10),
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: card.catalogue === 'adult' ? 'Yes' : 'No',
    rating: card.rating ? Number(card.rating) || null : null,
    chapterCount: card.chapterCount ?? null,
    locked: card.catalogue !== 'adult',
  };
}

/* --------------------------------------------------------------- search --- */

async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const text = String(query || '').trim();
  let genres = [];
  if (wanted && wanted.length) {
    genres = await Promise.all(wanted.map((name) => genreSlugFor(name)));
    genres = genres.filter(Boolean);
    // A tag this site does not know must not fall back to the whole catalogue.
    if (!genres.length) return { items: [], hasMore: false };
  }
  const result = await cataloguePage({ page, search: text, genres });
  const items = result.items.slice(0, limit).map(toItem);
  return { items, hasMore: result.hasMore && items.length >= limit, total: result.total };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* ----------------------------------------------------------------- tags --- */

const TAG_CACHE_KEY = 'toonx.tags';
let tagIndex = null;
let tagMode = null;

/**
 * Unlocked mode asks the site for its 600-odd categories. Locked mode has no
 * tag endpoint, so the vocabulary is the reading genres the clean catalogue is
 * actually built from — a slug the site does not use returns nothing rather
 * than silently widening the search.
 */
const LOCKED_TAGS = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Historical', 'Horror', 'Isekai',
  'Josei', 'Martial Arts', 'Mecha', 'Mystery', 'Psychological', 'Romance', 'School Life',
  'Sci-Fi', 'Seinen', 'Shoujo', 'Shounen', 'Slice of Life', 'Sports', 'Supernatural',
  'Thriller', 'Tragedy', 'Villainess',
];

function indexPath(list) {
  const map = new Map();
  list.forEach((entry) => {
    map.set(tagKey(entry.name), entry.slug);
    map.set(tagKey(entry.slug), entry.slug);
  });
  return map;
}

async function unlockedTags() {
  const text = await fetchText(`${BASE}/api/genres`, { headers: { ...HEADERS, Accept: 'application/json' } });
  let payload = [];
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('ToonX sent something that is not JSON.');
  }
  const list = (Array.isArray(payload) ? payload : [])
    .filter((entry) => entry && entry.name && entry.slug)
    .map((entry) => ({ name: cleanTagName(entry.name), slug: String(entry.slug) }))
    .filter((entry) => isUsableTag(entry.name));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function lockedTags() {
  return LOCKED_TAGS.map((name) => ({ name, slug: tagSlug(name, '-') }));
}

async function tags() {
  const mode = locked ? 'locked' : 'unlocked';
  if (tagMode === mode && tagIndex) return tagMode === mode ? cachedTags(mode) : [];
  const cached = readTagCache(`${TAG_CACHE_KEY}.${mode}`);
  let list = cached;
  if (!list) {
    list = mode === 'locked' ? lockedTags() : await unlockedTags();
    if (mode === 'unlocked') writeTagCache(`${TAG_CACHE_KEY}.${mode}`, list);
  }
  tagMode = mode;
  tagIndex = indexPath(list);
  tagCache = list;
  return list;
}

let tagCache = null;

function cachedTags(mode) {
  return mode === (locked ? 'locked' : 'unlocked') && tagCache ? tagCache : [];
}

async function genreSlugFor(name) {
  const value = String(name || '').trim();
  if (!value) return null;
  if (!tagIndex || tagMode !== (locked ? 'locked' : 'unlocked')) await tags();
  return tagIndex.get(tagKey(value)) || tagIndex.get(tagKey(tagSlug(value, '-'))) || null;
}

/* --------------------------------------------------------------- series --- */

const idFromRef = (ref = {}) => {
  const direct = String(ref.id || '').match(/^\d{4,9}$/);
  if (direct) return direct[0];
  const fromUrl = String(ref.url || '').match(/\/(\d{4,9})(?:[/?#]|$)/);
  return fromUrl ? fromUrl[1] : null;
};

const slugFromRef = (ref = {}) =>
  String(ref.slug || '').match(/^[a-z0-9\-_.]+$/)
    ? String(ref.slug)
    : String(ref.url || '').match(/\/(?:comic|manga|manhwa)\/([a-z0-9\-_.]+)/)?.[1] || null;

/** A card seen in a listing, or one found again by scanning the clean pages. */
async function summaryFor(comicId, ref = {}) {
  const known = summaryCache.get(String(comicId));
  if (known) return known;
  const pages = await Promise.all(
    [...OPEN_PAGES, '/adult/browse'].map((path) =>
      fetchText(`${BASE}${path}`, { headers: HEADERS }).catch(() => ''),
    ),
  );
  const cards = remember(pages.flatMap((html) => cardsFromHtml(html)));
  return (
    cards.find((card) => card.id === String(comicId)) || {
      id: String(comicId),
      slug: slugFromRef(ref) || null,
      url: ref.url || null,
      catalogue: String(ref.url || '').includes('/comic/') ? 'adult' : locked ? 'clean' : 'adult',
      title: String(ref.title || '').trim() || null,
      coverUrl: ref.coverUrl || null,
    }
  );
}

async function chaptersFor(comicId, { slug = null, base = 'manga' } = {}) {
  const text = await fetchText(`${BASE}/api/comics/${comicId}/chapters`, {
    headers: { ...HEADERS, Accept: 'application/json' },
  });
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('ToonX sent something that is not JSON.');
  }
  const list = Array.isArray(payload?.chapters) ? payload.chapters : [];
  return list
    .map((raw) => ({
      source: 'toonx',
      // The page list needs both ids and nothing else in the app carries the
      // comic, so the chapter id holds the pair: `<comicId>.<chapterId>`.
      id: `${comicId}.${raw.id}`,
      name: raw.title || `Chapter ${raw.chapterNumber}`,
      number: Number(raw.chapterNumber),
      url: slug ? `${BASE}/${base}/${slug}/${raw.slug || `chapter-${raw.chapterNumber}`}` : null,
      official: false,
      publishedAt: raw.date || null,
      pages: Number(raw.pageCount) || null,
    }))
    .filter((chapter) => Number.isFinite(chapter.number))
    .sort((a, b) => a.number - b.number);
}

/**
 * A pasted link carries no id: the card ids live in the catalogue markup. The
 * slug is matched against the cards already seen, then against the listing
 * pages, which is what makes a bare `toonx.to/manga/<slug>` link open.
 */
async function idForSlug(slug) {
  if (!slug) return null;
  const seen = [...summaryCache.values()].find((card) => card.slug === slug);
  if (seen) return seen.id;
  const pages = await Promise.all(
    [...OPEN_PAGES, '/adult/browse'].map((path) =>
      fetchText(`${BASE}${path}`, { headers: HEADERS }).catch(() => ''),
    ),
  );
  const cards = remember(pages.flatMap((html) => cardsFromHtml(html)));
  return cards.find((card) => card.slug === slug)?.id || null;
}

async function getSeries(ref = {}) {
  const comicId = idFromRef(ref) || (await idForSlug(slugFromRef(ref)));
  if (!comicId) throw new Error('That is not a ToonX series link.');

  const cached = await summaryFor(comicId, ref);
  const slug = slugFromRef(ref) || cached.slug || null;
  const catalogue = cached.catalogue || (String(ref.url || '').includes('/comic/') ? 'adult' : locked ? 'clean' : 'adult');
  const base = catalogue === 'adult' ? 'comic' : 'manga';
  const chapters = await chaptersFor(comicId, { slug, base });

  if (!chapters.length) {
    throw new Error('ToonX lists no chapters for this title.');
  }

  return {
    ...toItem({
      id: comicId,
      title: cached.title || String(ref.title || '').trim() || `ToonX ${comicId}`,
      url: `${BASE}/${base}/${slug || comicId}`,
      coverUrl: cached.coverUrl || null,
      catalogue,
      description: cached.description || '',
      genres: cached.genres || [],
      rating: cached.rating || null,
    }),
    id: String(comicId),
    slug,
    title: cached.title || String(ref.title || '').trim() || `ToonX ${comicId}`,
    url: `${BASE}/${base}/${slug || comicId}`,
    coverUrl: cached.coverUrl || ref.coverUrl || null,
    description: String(cached.description || '').replace(/\s+/g, ' ').slice(0, 1200),
    authors: [],
    tags: (cached.genres || []).map((genre) => genre.name || genre).filter(Boolean).slice(0, 12),
    adultContent: catalogue === 'adult' ? 'Yes' : 'No',
    downloadedLocked: catalogue !== 'adult',
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- chapter --- */

const pageCache = new Map();
const PAGE_CACHE_LIMIT = 60;

/**
 * A chapter's page list is not published, so each page is asked for in turn.
 * `.webp` is what most chapters use; a miss falls back to `.jpg` before the
 * index is called missing. Six at a time keeps a 40-page chapter around a
 * second instead of six.
 */
async function pageUrls(comicId, chapterId, pageCount) {
  const key = `${comicId}/${chapterId}`;
  if (pageCache.has(key)) return pageCache.get(key);

  const indexes = Array.from({ length: pageCount }, (_, i) => String(i + 1).padStart(3, '0'));
  const out = new Array(indexes.length).fill(null);

  const probe = async (name, index) => {
    for (const ext of ['webp', 'jpg', 'png', 'avif']) {
      const url = `${IMG}/chapters/${comicId}/${chapterId}/${name}.${ext}`;
      try {
        const response = await fetch(url, { method: 'HEAD', headers: HEADERS });
        if (response.ok) {
          out[index] = url;
          return;
        }
        // 403/5xx on the first guess means the host is refusing us, not that
        // the file is missing; stop guessing rather than hammering it.
        if (response.status !== 404) return;
      } catch {
        return;
      }
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < indexes.length) {
      const index = cursor;
      cursor += 1;
      await probe(indexes[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, indexes.length) }, worker));

  const images = out.filter(Boolean);
  if (pageCache.size > PAGE_CACHE_LIMIT) pageCache.clear();
  pageCache.set(key, images);
  return images;
}

/** The chapter list is the only place that says how long a chapter is. */
const chapterListCache = new Map();

async function pageCountFor(comicId, chapterId) {
  if (!chapterListCache.has(String(comicId))) {
    const text = await fetchText(`${BASE}/api/comics/${comicId}/chapters`, {
      headers: { ...HEADERS, Accept: 'application/json' },
    });
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const list = Array.isArray(payload?.chapters) ? payload.chapters : [];
    chapterListCache.set(String(comicId), list);
  }
  const list = chapterListCache.get(String(comicId)) || [];
  const found = list.find((entry) => String(entry.id) === String(chapterId));
  return Number(found?.pageCount) || 0;
}

async function getChapterImages(chapter = {}) {
  const pair = String(chapter.id || '').match(/^(\d{4,9})[.:/](\d{4,9})$/);
  const comicId = pair ? pair[1] : String(chapter.comicId || chapter.seriesId || '').match(/^\d{4,9}$/)?.[0];
  const chapterId = pair ? pair[2] : String(chapter.id || '').match(/^\d{4,9}$/)?.[0];
  if (!comicId || !chapterId) throw new Error('That ToonX chapter is missing its id.');
  // The reader hands the length over with the chapter; a download only keeps the
  // id, so the length is asked for when it is missing.
  const pageCount = Number(chapter.pages || chapter.pageCount || 0) || (await pageCountFor(comicId, chapterId));
  if (!pageCount) throw new Error('ToonX did not say how many pages this chapter has.');
  const images = await pageUrls(comicId, chapterId, Math.min(pageCount, 200));
  if (!images.length) throw new Error('ToonX did not serve any pages for this chapter.');
  return { images, thumbs: images, referer: `${BASE}/` };
}

/* --------------------------------------------------- trending + picks ---- */

/**
 * The search home wall wants covers, and a source with nothing to put there is
 * invisible on it. Both catalogues have a front page, so the wall follows the
 * lock like everything else.
 */
async function trending({ limit = 24 } = {}) {
  const result = await cataloguePage({ page: 1 });
  return result.items.slice(0, limit).map(toItem);
}

async function recommendations({ limit = 12 } = {}) {
  const result = await cataloguePage({ page: 1 });
  // The front page is not a ranking, so a different slice keeps the picks from
  // being the same four covers the wall already shows.
  const items = result.items.slice(0, Math.max(limit * 2, 24));
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit).map(toItem);
}

/* ---------------------------------------------------------------- links --- */

function parseInput(text = '') {
  const value = String(text).trim();
  if (!/toonx\.to/i.test(value)) return null;
  const slug = value.match(/\/(?:comic|manga|manhwa)\/([a-z0-9\-_.]+)/i)?.[1];
  if (!slug) return null;
  return { source: 'toonx', slug, url: value, catalogue: /\/comic\//i.test(value) ? 'adult' : 'clean' };
}

module.exports = {
  id: 'toonx',
  label: 'ToonX',
  short: 'TX',
  homepage: BASE,
  hosts: ['toonx.to', 'www.toonx.to'],
  hasTags: true,
  locked: true,
  parseInput,
  seriesUrl: (slug) => `${BASE}/${locked ? 'manga' : 'comic'}/${slug}`,
  setLocked,
  isLocked,
  search,
  searchPage,
  tags,
  trending,
  recommendations,
  getSeries,
  getChapterImages,
};
