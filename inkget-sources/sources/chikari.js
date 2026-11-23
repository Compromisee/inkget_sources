'use strict';

/**
 * Chikari — SvelteKit front end over a JSON API.
 *
 *   /api/series?q=&sort=&limit=&offset=   catalogue + search (paged by offset)
 *   /api/series/<slug>                    series detail (genres, tags, authors)
 *   /api/series/<slug>/chapters           chapter list
 *   /api/series/<slug>/chapters/<number>  page images
 *
 * Browsing is filtered with `/api/series?genre=<slug>`, fed by `/api/genres`.
 * The 1200-entry `/api/tags` list is per-series metadata only — the search API
 * ignores it — so the filter vocabulary is the genre list. A label this site
 * does not know produces no results rather than the unfiltered catalogue.
 *
 *   /api/lists                     public reading lists
 *   /api/lists/<id>                one list, with its series and genres
 *
 * Reading-list links (`/lists/<id>` or `/lists/<slug>`) are treated as their own
 * kind of reference so the app can offer a bulk download for the whole list.
 */

const { fetchText } = require('../http');
const { cleanTagName, isUsableTag, tagKey, tagSlug, readTagCache, writeTagCache } = require('./tag-utils');

const BASE = 'https://chikari.moe';
const API = `${BASE}/api`;

const seriesUrl = (slug) => `${BASE}/series/${slug}`;
const chapterUrl = (slug, number) => `${BASE}/series/${slug}/chapter-${number}`;

async function apiJson(path, params = {}) {
  // `path` is appended to the /api prefix, so build the URL by string.
  const url = new URL(`${API}${path.startsWith('/') ? '' : '/'}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((item) => url.searchParams.append(key, String(item)));
      return;
    }
    url.searchParams.set(key, String(value));
  });
  const text = await fetchText(url.toString(), { headers: { Accept: 'application/json' } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Chikari sent something that is not JSON.');
  }
}

const slugFromUrl = (url = '') => String(url).match(/\/series\/([a-z0-9-]+)/i)?.[1] || null;
const numberFromUrl = (url = '') => String(url).match(/chapter-([\d.]+)/i)?.[1] || null;

/* Chikari's canonical list URL is `id-slug` (`/lists/2249-manwhas`), and the
   bare id (`/lists/2249`) resolves too. */
const listUrl = (id, slug) =>
  slug && !String(slug).startsWith(String(id)) ? `${BASE}/lists/${id}-${slug}` : `${BASE}/lists/${id}`;

/* `chikari.moe/lists/2249-manwhas`, `.../lists/2249`, `.../l/2249-manwhas`, the
   same thing behind a profile path, and the older slug-only `lists/my-list` all
   name one list. The id is what the API wants; the label is decoration. */
const LIST_HREF = /chikari\.moe\/(?:[^/?#]+\/)*?l(?:ists?)?\/(\d+)(?:-([a-z0-9-]+))?/i;
const LIST_SLUG_HREF = /chikari\.moe\/(?:[^/?#]+\/)*?l(?:ists?)?\/([a-z0-9][a-z0-9-]*)/i;

function parseListHref(value) {
  const text = String(value || '');
  const byId = text.match(LIST_HREF);
  if (byId) return { id: byId[1], slug: byId[2] || null };
  const bySlug = text.match(LIST_SLUG_HREF);
  if (bySlug) return { id: null, slug: bySlug[1] };
  return null;
}

function parseInput(text = '') {
  const value = String(text).trim();

  const list = parseListHref(value);
  if (list) {
    return {
      type: 'list',
      source: 'chikari',
      id: list.id || list.slug,
      slug: list.slug,
      url: list.id ? listUrl(list.id, list.slug) : `${BASE}/lists/${list.slug}`,
    };
  }

  const chapter = value.match(/chikari\.moe\/series\/([a-z0-9-]+)\/chapter-([\d.]+)/i);
  if (chapter) {
    return {
      type: 'chapter',
      source: 'chikari',
      id: `${chapter[1]}/${chapter[2]}`,
      slug: chapter[1],
      url: chapterUrl(chapter[1], chapter[2]),
    };
  }
  const series = value.match(/chikari\.moe\/series\/([a-z0-9-]+)/i);
  if (series) {
    return { type: 'series', source: 'chikari', id: series[1], slug: series[1], url: seriesUrl(series[1]) };
  }
  return null;
}

function toItem(raw, extra = {}) {
  const slug = raw.slug;
  return {
    source: 'chikari',
    id: String(raw.id || slug),
    slug,
    title: String(raw.title || 'Untitled').trim(),
    url: seriesUrl(slug),
    coverUrl: raw.cover_url || null,
    type: raw.type ? String(raw.type).replace(/^\w/, (c) => c.toUpperCase()) : 'Manhwa',
    status: raw.status || null,
    year: raw.year || null,
    tags: Array.isArray(raw.genres) ? raw.genres.map((entry) => entry.name || entry).filter(Boolean) : [],
    nsfw: raw.is_nsfw === true,
    rating: raw.rating ?? null,
    views: raw.views ?? null,
    latestChapter: raw.latest_chapter ?? null,
    chapterCount: raw.chapter_count ?? null,
    ...extra,
  };
}

async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const text = String(query || '').trim();
  const offset = Math.max(0, (page - 1) * limit);
  // A genre this site does not know must not fall through to the whole
  // catalogue: that is what made every tag selection look identical.
  let genres = [];
  if (wanted && wanted.length) {
    genres = await Promise.all(wanted.map((name) => genreSlugFor(name)));
    genres = genres.filter(Boolean);
    if (!genres.length) return { items: [], hasMore: false };
  }

  const params = {
    sort: text ? 'relevance' : 'popular',
    q: text || undefined,
    type: ['manga', 'manhwa', 'manhua'],
    limit,
    offset,
  };
  if (genres.length) params.genre = genres[0];

  // The site's own Safe / 18+ switch. `adult` is exclusive — false returns clean
  // series only, true returns 18+ only — and `/api/series` reads the parameter
  // rather than the session cookie (the cookie only drives the site's own
  // pages), so it is always sent. When a source is routed its preference has
  // already been adopted from the window, so this is the window's answer.
  const content = require('../prefs-store').forSource('chikari');
  params.adult = content?.content === 'nsfw';

  // `sort=relevance` only makes sense with a query; fall back to popular.
  if (!text) delete params.sort;

  const payload = await apiJson('/series', params);
  const items = (payload?.items || []).map((raw) => toItem(raw));
  const total = Number(payload?.total ?? payload?.count ?? 0);
  return { items, hasMore: total ? offset + items.length < total : items.length >= limit };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* --------------------------------------------------------------- tags -- */

const TAG_CACHE_KEY = 'chikari.genres';
let tagIndex = null;

async function tags() {
  const cached = readTagCache(TAG_CACHE_KEY);
  if (cached) {
    if (!tagIndex) tagIndex = indexOf(cached);
    return cached;
  }

  const payload = await apiJson('/genres');
  const list = (Array.isArray(payload) ? payload : [])
    .filter((entry) => entry && entry.name && Number(entry.count || 0) >= 5)
    .map((entry) => ({
      name: cleanTagName(entry.name),
      slug: String(entry.slug || tagSlug(entry.name, '_')),
      count: entry.count,
    }))
    .filter((entry) => isUsableTag(entry.name));
  list.sort((a, b) => a.name.localeCompare(b.name));
  tagIndex = indexOf(list);
  return writeTagCache(TAG_CACHE_KEY, list);
}

function indexOf(list) {
  const map = new Map();
  list.forEach((entry) => {
    map.set(tagKey(entry.name), entry.slug);
    map.set(tagKey(entry.slug), entry.slug);
  });
  return map;
}

/** Map a label onto a genre slug; unknown labels resolve to null, never to a guess. */
async function genreSlugFor(name) {
  const key = tagKey(name);
  if (!key) return null;
  if (!tagIndex) await tags().catch(() => null);
  return tagIndex ? tagIndex.get(key) || null : null;
}

/* ------------------------------------------------------------- series -- */

/**
 * Every chapter of a series.
 *
 * The chapter route caps a page at 200 entries and answers newest-first, so a
 * 400-chapter series used to hand back only its latest 200 — and a download of
 * "chapters 1-20" then matched nothing and quietly queued an empty job. This
 * walks the pages until it has the count the route reports.
 */
async function apiAllChapters(kind, slug) {
  const limit = 200;
  const collected = new Map();
  let total = null;

  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await apiJson(`/${kind}/${slug}/chapters`, { limit, offset });
    const items = page?.items || [];
    if (Number.isFinite(Number(page?.total))) total = Number(page.total);
    items.forEach((raw) => {
      const number = Number(raw?.number);
      if (Number.isFinite(number) && !collected.has(number)) collected.set(number, raw);
    });
    if (items.length < limit) break;
    if (total !== null && collected.size >= total) break;
  }

  return [...collected.values()];
}

/**
 * Which slug a reference points at.
 *
 * Chikari ids are database numbers with no route of their own (`/series/5` is a
 * 404), so a numeric id must never win over the slug in the link: list entries
 * carry both, and picking the number made those series unopenable.
 */
function slugFromRef(ref = {}) {
  const usable = (value) => (value && !/^\d+$/.test(String(value)) ? String(value) : null);
  return usable(ref.slug) || slugFromUrl(ref.url || '') || usable(ref.id);
}

async function getSeries(ref = {}) {
  const slug = slugFromRef(ref);
  if (!slug) throw new Error('That is not a Chikari series link.');

  // Novels are a separate collection on this site: same shape, different route,
  // and text instead of page images (so a novel can be read, not downloaded).
  let kind = 'series';
  let detail = null;
  try {
    detail = await apiJson(`/series/${slug}`);
  } catch {
    detail = await apiJson(`/novels/${slug}`);
    kind = 'novels';
  }
  if (!detail || !detail.id) throw new Error('Chikari did not return that series.');

  let chapters = [];
  try {
    const payload = await apiAllChapters(kind, slug);
    chapters = (payload || [])
      .map((raw) => ({
        source: 'chikari',
        id: String(raw.number),
        name: raw.title || `Chapter ${raw.number}`,
        number: Number(raw.number),
        url: chapterUrl(slug, raw.number),
        official: false,
        publishedAt: raw.created_at || null,
      }))
      .filter((entry) => Number.isFinite(entry.number))
      .sort((a, b) => a.number - b.number);
  } catch {
    chapters = [];
  }

  const genres = (detail.genres || []).map((entry) => entry.name || entry).filter(Boolean);
  const extraTags = (detail.tags || []).map((entry) => entry.name || entry).filter(Boolean);

  return {
    ...toItem(detail),
    id: String(detail.id),
    slug,
    medium: kind === 'novels' ? 'novel' : 'comic',
    downloadable: kind === 'series',
    title: detail.title || 'Untitled',
    url: seriesUrl(slug),
    coverUrl: detail.cover_url || null,
    description: String(detail.description || '').replace(/\s+/g, ' ').slice(0, 1200),
    authors: (detail.authors || []).map((entry) => entry.name || entry).filter(Boolean),
    associatedNames: Array.isArray(detail.alt_titles) ? detail.alt_titles.filter(Boolean) : [],
    tags: [...new Set([...genres, ...extraTags])].slice(0, 12),
    status: detail.status || null,
    released: detail.year || null,
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: detail.is_nsfw ? 'Yes' : 'No',
    related: [],
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------ chapter -- */

async function getChapterImages(chapter = {}) {
  if (chapter.medium === 'novel' || /\/novels?\//i.test(String(chapter.url || ''))) {
    throw new Error('Chikari novels are text, so there are no pages to download.');
  }
  const match = String(chapter.url || '').match(/\/series\/([a-z0-9-]+)\/chapter-([\d.]+)/i);
  if (!match) throw new Error('That is not a Chikari chapter link.');
  const payload = await apiJson(`/series/${match[1]}/chapters/${match[2]}`);
  const images = Array.isArray(payload?.pages) ? payload.pages.filter(Boolean) : [];
  if (!images.length) throw new Error('No pages found for this chapter.');
  return { images, referer: `${BASE}/` };
}

/* --------------------------------------------------- trending + picks -- */

async function trending({ limit = 24 } = {}) {
  const payload = await apiJson('/series', { sort: 'popular', limit, offset: 0, type: ['manga', 'manhwa', 'manhua'] });
  return (payload?.items || []).map((raw) => toItem(raw));
}

async function recommendations({ limit = 12 } = {}) {
  const payload = await apiJson('/series', { sort: 'trending', limit, offset: 0, type: ['manga', 'manhwa', 'manhua'] });
  return (payload?.items || []).map((raw) => toItem(raw));
}

/* -------------------------------------------------------------- lists -- */

/**
 * Public lists hold ids only, so a slug reference has to be looked up. Links
 * arrive as `id-slug` (`2249-manwhas`), which is an id plus a label: the id is
 * the part the API accepts, so it is read off the front and used directly.
 */
async function resolveListId(ref) {
  const value = String(ref || '').trim();
  if (/^\d+$/.test(value)) return Number(value);

  const labelled = value.match(/^(\d+)-[a-z0-9-]+$/i);
  if (labelled) return Number(labelled[1]);

  // A bare slug: the lists endpoint filters by `slug`, so one request is enough.
  const slug = value.toLowerCase();
  const exact = await apiJson('/lists', { slug, limit: 50, offset: 0 }).catch(() => null);
  const hit = (exact?.items || []).find((entry) => String(entry.slug).toLowerCase() === slug);
  if (hit) return Number(hit.id);

  // Last resort for a near miss (a renamed list, a slug with punctuation):
  // search, then walk the catalogue if the site has nothing to offer.
  const loose = await apiJson('/lists', { search: slug, limit: 50, offset: 0 }).catch(() => null);
  const near = (loose?.items || []).find((entry) => String(entry.slug).toLowerCase() === slug);
  if (near) return Number(near.id);

  const total = Number(loose?.total || 0);
  for (let offset = 0; offset < Math.min(total, 2000); offset += 50) {
    const payload = await apiJson('/lists', { limit: 50, offset });
    const items = payload?.items || [];
    const found = items.find((entry) => String(entry.slug).toLowerCase() === slug);
    if (found) return Number(found.id);
    if (items.length < 50) break;
  }
  return null;
}

/**
 * One reading list: its series, each with the metadata the list page needs to
 * offer a bulk download.
 */
async function getList(ref = {}) {
  // A list can arrive as an id, a slug or a full link; all three end up here.
  const fromUrl = parseListHref(ref.url);
  const reference = fromUrl?.id || ref.id || fromUrl?.slug || ref.slug || ref.url;
  const id = await resolveListId(reference);
  if (!id) throw new Error('That list could not be found on Chikari.');

  const payload = await apiJson(`/lists/${id}`);
  const items = (payload?.items || []).map((raw) => toItem(raw));

  return {
    source: 'chikari',
    id: String(payload?.id || id),
    slug: payload?.slug || String(id),
    title: String(payload?.title || `List ${id}`).trim(),
    description: String(payload?.description || '').trim(),
    owner: payload?.owner?.username || null,
    count: Number(payload?.item_count || items.length),
    url: listUrl(payload?.id || id, payload?.slug),
    genres: (payload?.genres || []).map((entry) => entry.name).filter(Boolean),
    items,
  };
}

module.exports = {
  id: 'chikari',
  label: 'Chikari',
  short: 'CH',
  homepage: BASE,
  hosts: ['chikari.moe'],
  hasTags: true,
  parseInput,
  slugFromUrl,
  seriesUrl,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  getList,
  recommendations,
  trending,
};
