'use strict';

/**
 * Omega Scans — Next.js front end over a JSON API.
 *
 * Everything the reader needs is on `api.omegascans.org`: `/query` lists and
 * searches series, `/chapter/query` lists a series' chapters, and
 * `/chapter/<series-slug>/<chapter-slug>` returns the page images for chapters
 * that are not behind the coin paywall.
 *
 * Tags: the site has no usable tag vocabulary, so it declares `hasTags: false`
 * and is simply skipped when the unified tag set is built.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const BASE = 'https://omegascans.org';
const API = 'https://api.omegascans.org';
const HEADERS = {
  Referer: `${BASE}/`,
  Origin: BASE,
  Accept: 'application/json, text/plain, */*',
};

const seriesUrl = (slug) => `${BASE}/series/${slug}`;
const chapterUrl = (seriesSlug, chapterSlug) => `${BASE}/series/${seriesSlug}/${chapterSlug}`;

async function apiJson(path, params = {}) {
  const url = new URL(path, API);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, String(value));
  });
  const text = await fetchText(url.toString(), { headers: HEADERS });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Omega Scans sent something that is not JSON.');
  }
}

function parseInput(text = '') {
  const value = String(text).trim();
  const chapter = value.match(/omegascans\.org\/series\/([a-z0-9-]+)\/(chapter-[\w.-]+)/i);
  if (chapter) {
    return {
      type: 'chapter',
      source: 'omegascans',
      id: `${chapter[1]}/${chapter[2]}`,
      slug: chapter[1],
      url: chapterUrl(chapter[1], chapter[2]),
    };
  }
  const series = value.match(/omegascans\.org\/series\/([a-z0-9-]+)/i);
  if (series) {
    return { type: 'series', source: 'omegascans', id: series[1], slug: series[1], url: seriesUrl(series[1]) };
  }
  return null;
}

const slugFromUrl = (url = '') => String(url).match(/\/series\/([a-z0-9-]+)/i)?.[1] || null;

function toItem(raw, extra = {}) {
  const slug = raw.series_slug || raw.slug;
  return {
    source: 'omegascans',
    id: String(raw.id || slug),
    slug,
    title: String(raw.title || 'Untitled').trim(),
    url: seriesUrl(slug),
    coverUrl: raw.thumbnail || null,
    type: raw.series_type === 'Novel' ? 'Novel' : 'Manhwa',
    status: raw.status || null,
    year: (String(raw.created_at || '').match(/\b(19|20)\d{2}\b/) || [])[0] || null,
    tags: [],
    rating: raw.rating ?? null,
    views: raw.total_views ?? null,
    latestChapter: raw.latest_chapter || null,
    description: raw.description || '',
    ...extra,
  };
}

/** Page of the catalogue. `tags` is ignored: Omega Scans has no tag filter. */
async function searchPage(query, { limit = 24, page = 1 } = {}) {
  const text = String(query || '').trim();
  const params = {
    adult: 'true',
    query_string: text,
    page,
    perPage: limit,
  };
  // A plain listing is ordered by freshness; a search by relevance default.
  if (!text) {
    params.orderBy = 'created_at';
    params.order = 'desc';
    params.series_type = 'Comic';
    params.status = 'All';
    params.light = 'true';
  }

  const payload = await apiJson('/query', params);
  const items = (payload?.data || []).map((raw) => toItem(raw));
  const meta = payload?.meta || {};
  return { items, hasMore: Number(meta.current_page || page) < Number(meta.last_page || page) };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/** Series metadata + chapter list. Needs the numeric series id for chapters. */
async function getSeries(ref = {}) {
  const slug = ref.slug || ref.id || slugFromUrl(ref.url || '');
  if (!slug) throw new Error('That is not an Omega Scans series link.');

  // The id lives in the page's own payload; the public API has no by-slug route.
  const html = await fetchText(seriesUrl(slug));
  const $ = cheerio.load(html);
  const id =
    html.match(/series_id\\?":\s*"?(\d+)/)?.[1] ||
    html.match(/series\\?":\s*(\d+)/)?.[1] ||
    null;

  let meta = toItem({ series_slug: slug, title: $('title').text().replace(/\s*-\s*Omega Scans.*$/i, '').trim(), slug });
  meta.description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';
  const ogCover = $('meta[property="og:image"]').attr('content');
  if (ogCover) meta.coverUrl = ogCover;

  if (!id) throw new Error('Could not read that series from Omega Scans.');

  let chapters = [];
  try {
    const payload = await apiJson('/chapter/query', { page: 1, perPage: 10000, series_id: id });
    chapters = (payload?.data || [])
      .map((raw) => ({
        source: 'omegascans',
        id: raw.chapter_slug,
        name: raw.chapter_name || raw.chapter_slug,
        number: Number(raw.index ?? String(raw.chapter_name || '').replace(/[^\d.]/g, '')) || null,
        url: chapterUrl(String(raw.series?.series_slug || slug), raw.chapter_slug),
        official: false,
        publishedAt: raw.created_at || null,
        locked: Number(raw.price || 0) > 0 && (!raw.free_at || new Date(raw.free_at) > new Date()),
      }))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  } catch {
    chapters = [];
  }

  return {
    ...meta,
    id,
    slug,
    title: meta.title || 'Untitled',
    url: seriesUrl(slug),
    authors: [],
    associatedNames: [],
    released: meta.year,
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getChapterImages(chapter = {}) {
  const match = String(chapter.url || '').match(/\/series\/([a-z0-9-]+)\/(chapter-[\w.-]+)/i);
  if (!match) throw new Error('That is not an Omega Scans chapter link.');
  const payload = await apiJson(`/chapter/${match[1]}/${match[2]}`);
  if (payload?.paywall) throw new Error('That chapter is behind Omega Scans coins.');
  const images = payload?.chapter?.chapter_data?.images || [];
  if (!images.length) throw new Error('No pages found for this chapter.');
  return { images, referer: `${BASE}/` };
}

/** Popular series for the trending wall. */
async function trending({ limit = 24 } = {}) {
  const payload = await apiJson('/query', {
    adult: 'true',
    query_string: '',
    page: 1,
    perPage: limit,
    orderBy: 'total_views',
    order: 'desc',
    series_type: 'Comic',
    status: 'All',
    light: 'true',
  });
  return (payload?.data || []).map((raw) => toItem(raw));
}

const recommendations = trending;

/** Omega Scans has no tag vocabulary. */
async function tags() {
  return [];
}

module.exports = {
  id: 'omegascans',
  label: 'Omega Scans',
  short: 'OS',
  homepage: BASE,
  hosts: ['omegascans.org'],
  hasTags: false,
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
