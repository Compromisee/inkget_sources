'use strict';

/**
 * MangaBaka — a catalogue, not a reader.
 *
 *   GET https://api.mangabaka.org/v1/series/search?q=&page=&limit=
 *   GET https://api.mangabaka.org/v1/series/<id>
 *   GET https://api.mangabaka.org/v1/tags?page=&limit=      (7,151 tags)
 *
 * The old `api.mangabaka.dev` host is retired and answers every request with a
 * 500 telling you to move here, so there is exactly one host to use.
 *
 * Every entry carries a cover, genres, the site's own tag vocabulary, a
 * content rating, the original language and a rating out of ten. There are no
 * chapters and no pages: this is the library you keep *about* what you read, so
 * a series opened from here is read-only, like Chikari's novels. Matching a
 * download list against it is handled by `lib/sync/mangabaka.js`.
 */

const { fetchText } = require('../http');
const { cleanTagName, isUsableTag } = require('./tag-utils');

const BASE = 'https://mangabaka.org';
const API = 'https://api.mangabaka.org/v1';

const TAG_CACHE = 'mangabaka.tags.v2';
const TAG_TTL = 1000 * 60 * 60 * 24 * 3;

let tagCache = null;

/**
 * The public catalogue needs no key at all; a key raises the rate limit and is
 * what the app offers in Settings instead of a sign-in window. It travels as a
 * x-api-key header and is never written to `info.xml` or anywhere else on disk.
 */
function apiKey() {
  try {
    return require('../prefs-store').credentialFor('mangabaka')?.apiKey || '';
  } catch {
    return '';
  }
}

async function apiJson(path, params = {}) {
  const url = new URL(`${API}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  const key = apiKey();
  const text = await fetchText(url.toString(), {
    headers: key
      ? { Accept: 'application/json', 'x-api-key': key }
      : { Accept: 'application/json' },
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('MangaBaka sent something that is not JSON.');
  }
}

/** `mangabaka.org/manhwa/3397/Solo-Leveling`, `.../series/3397`, or a bare id. */
function parseInput(text = '') {
  const value = String(text).trim();
  const url = value.match(/mangabaka\.org\/([a-z]+)\/(\d+)(?:\/([A-Za-z0-9-]+))?/i);
  if (url) {
    return { type: 'series', source: 'mangabaka', id: url[2], slug: url[3] || url[2] };
  }
  if (/^\d{2,8}$/.test(value)) return { type: 'series', source: 'mangabaka', id: value, slug: value };
  return null;
}

const coverOf = (raw) =>
  raw?.cover?.x250?.x1 ||
  raw?.cover?.x350?.x1 ||
  raw?.cover?.raw?.url ||
  null;

const ratingOf = (raw) => {
  const value = Number(raw?.rating);
  return Number.isFinite(value) && value > 0 ? Math.round((value / 10) * 10) / 10 : null;
};

const titleCase = (value) => String(value || '').replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());

function toItem(raw) {
  const type = String(raw.type || 'manga');
  const id = String(raw.id);
  return {
    source: 'mangabaka',
    id,
    slug: id,
    title: String(raw.title || 'Untitled').trim(),
    url: raw.canonical_url || `${BASE}/${type}/${id}/${String(raw.title || '').replace(/\s+/g, '-')}`,
    coverUrl: coverOf(raw),
    type: titleCase(type),
    status: raw.status ? titleCase(String(raw.status).replace(/_/g, ' ')) : null,
    year: raw.year || null,
    tags: [...new Set([...(raw.genres || []).map(titleCase), ...(raw.tags || [])])].slice(0, 12),
    rating: ratingOf(raw),
    views: Number(raw.popularity) || null,
    latestChapter: null,
    chapterCount: Number(raw.total_chapters) || null,
    language: raw.original_language || null,
    contentRating: raw.content_rating || null,
    medium: 'catalogue',
    downloadable: false,
  };
}

/**
 * Search the catalogue.
 *
 * `tags` are applied here rather than at the API: the search endpoint rejects
 * unknown filter keys (it validates strictly), and a page of results already
 * carries every tag, so filtering a page costs nothing.
 */
async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const payload = await apiJson('/series/search', {
    q: String(query || '').trim() || undefined,
    page: Math.max(1, page),
    limit: Math.max(1, Math.min(50, limit)),
  });

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const wantedKeys = (wanted || []).map((tag) => String(tag).toLowerCase());
  const items = rows
    .map(toItem)
    .filter((item) => {
      if (!wantedKeys.length) return true;
      const own = item.tags.map((tag) => tag.toLowerCase());
      return wantedKeys.every((tag) => own.some((value) => value === tag || value.includes(tag)));
    });

  const pagination = payload?.pagination || {};
  const total = Number(pagination.count) || 0;
  const seen = Math.max(0, (Number(pagination.page) || page) - 1) * (Number(pagination.limit) || limit) + rows.length;
  return { items, hasMore: Boolean(pagination.next) || (total ? seen < total : items.length >= limit) };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* --------------------------------------------------------------- tags -- */

/**
 * The whole tag vocabulary (7,151 entries), walked page by page and cached for
 * three days. `name_path` is the site's own hierarchy — "Actions > Fighting" —
 * so the last segment is the label people actually search for.
 */
async function tags() {
  if (tagCache) return tagCache;
  try {
    const cached = JSON.parse(await require('node:fs/promises').readFile(require('node:path').join(require('node:os').tmpdir(), 'inkget-mangabaka-tags.json'), 'utf8'));
    if (cached && Date.now() - cached.at < TAG_TTL && Array.isArray(cached.items) && cached.items.length) {
      tagCache = cached.items;
      return tagCache;
    }
  } catch {
    /* No cache yet, or it aged out. */
  }

  const seen = new Map();
  for (let page = 1; page <= 40; page += 1) {
    let payload;
    try {
      payload = await apiJson('/tags', { page, limit: 100 });
    } catch {
      break;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!rows.length) break;
    rows.forEach((entry) => {
      const label = String(entry.name || '').trim();
      if (!label || seen.has(label.toLowerCase())) return;
      seen.set(label.toLowerCase(), {
        name: cleanTagName(label),
        slug: String(entry.id),
        path: entry.name_path || label,
        group: String(entry.name_path || '').split('>')[0].trim() || null,
        count: Number(entry.series_count) || null,
      });
    });
    if (!payload?.pagination?.next) break;
  }

  const list = [...seen.values()].filter((entry) => isUsableTag(entry.name));
  list.sort((a, b) => a.name.localeCompare(b.name));
  tagCache = list;
  try {
    await require('node:fs/promises').writeFile(
      require('node:path').join(require('node:os').tmpdir(), 'inkget-mangabaka-tags.json'),
      JSON.stringify({ at: Date.now(), items: list }),
      'utf8',
    );
  } catch {
    /* A cache that cannot be written is only a slower next run. */
  }
  return list;
}

/* ------------------------------------------------------------- series -- */

async function getSeries(ref = {}) {
  const id = String(ref.id || ref.slug || '').match(/\d{2,8}/)?.[0];
  if (!id) throw new Error('That is not a MangaBaka link.');
  const payload = await apiJson(`/series/${id}`);
  const raw = payload?.data;
  if (!raw) throw new Error('MangaBaka did not return that series.');

  const item = toItem(raw);
  return {
    ...item,
    description: String(raw.description || '').replace(/\s+/g, ' ').slice(0, 1200),
    authors: (raw.authors || []).filter(Boolean),
    artists: (raw.artists || []).filter(Boolean),
    associatedNames: [
      raw.native_title,
      raw.romanized_title,
      ...Object.values(raw.secondary_titles || {}).flat().map((entry) => entry?.title),
    ].filter(Boolean).slice(0, 12),
    status: raw.status ? titleCase(String(raw.status).replace(/_/g, ' ')) : null,
    released: raw.year || null,
    officialTranslation: raw.is_licensed ? 'Yes' : 'No',
    animeAdaptation: raw.has_anime ? 'Yes' : 'No',
    adultContent: raw.content_rating === 'safe' ? 'No' : titleCase(raw.content_rating || 'unknown'),
    tags: [...new Set([...(raw.genres || []).map(titleCase), ...(raw.tags || [])])].slice(0, 16),
    chapters: [],
    chapterCount: Number(raw.total_chapters) || 0,
    latestChapter: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getChapterImages() {
  throw new Error('MangaBaka is a catalogue: it has no pages to download.');
}

/** Its own "popular this month", for the wall. */
async function trending({ limit = 24 } = {}) {
  try {
    const payload = await apiJson('/series/search', { q: undefined, page: 1, limit: Math.min(50, limit) });
    return (payload?.data || []).map(toItem);
  } catch {
    return [];
  }
}

async function recommendations({ limit = 12 } = {}) {
  return trending({ limit });
}

module.exports = {
  id: 'mangabaka',
  label: 'MangaBaka',
  short: 'MB',
  homepage: BASE,
  hosts: ['mangabaka.org', 'api.mangabaka.org'],
  hasTags: true,
  catalogueOnly: true,
  parseInput,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  trending,
  recommendations,
};
