'use strict';

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const BASE = 'https://weebcentral.com';
const CDN = 'https://temp.compsci88.com';
const ID_RE = /[0-9A-HJKMNP-TV-Z]{26}/; // ULID alphabet

const seriesIdFromUrl = (url = '') => String(url).match(/\/series\/([0-9A-Z]{20,32})/i)?.[1]?.toUpperCase() || null;
const chapterIdFromUrl = (url = '') => String(url).match(/\/chapters\/([0-9A-Z]{20,32})/i)?.[1]?.toUpperCase() || null;
const slugFromUrl = (url = '') => String(url).match(/\/series\/[0-9A-Z]{20,32}\/([^/?#]+)/i)?.[1] || null;

function chapterNumberFromName(name = '') {
  const numbers = String(name).match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  const value = Number(numbers[numbers.length - 1]);
  return Number.isFinite(value) ? value : null;
}

const coverUrl = (id) => `${CDN}/cover/fallback/${id}.jpg`;

function parseInput(text = '') {
  const value = String(text).trim();
  const chapterId = chapterIdFromUrl(value);
  if (chapterId) return { type: 'chapter', id: chapterId, source: 'weebcentral' };
  const seriesId = seriesIdFromUrl(value);
  if (seriesId) return { type: 'series', id: seriesId, slug: slugFromUrl(value), source: 'weebcentral' };
  if (ID_RE.test(value) && value.length >= 24 && value.length <= 32) {
    return { type: 'series', id: value.toUpperCase(), source: 'weebcentral' };
  }
  return null;
}


/* ---------------------------------------------------------------- tags -- */

let tagCache = null;

/** The advanced search form renders every tag as `tag-<Name>` checkboxes. */
async function tags() {
  if (tagCache && Date.now() - tagCache.at < 60 * 60 * 1000) return tagCache.tags;
  const html = await fetchText(`${BASE}/search`);
  const $ = cheerio.load(html);
  const names = [];
  $('input[id^="tag-"][id$="-value"]').each((_, input) => {
    const value = ($(input).attr('value') || '').trim();
    if (value && !names.includes(value)) names.push(value);
  });
  const list = names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, slug: name }));
  tagCache = { at: Date.now(), tags: list };
  return list;
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('article').each((_, element) => {
    const article = $(element);
    const link = article.find('a[href*="/series/"]').first();
    const href = link.attr('href') || '';
    const id = seriesIdFromUrl(href);
    if (!id) return;

    const title = article.find('h2').first().text().trim() || link.attr('data-tip') || 'Untitled';
    const meta = article.find('section').eq(0).find('div').map((__, div) => $(div).text().trim()).get().filter(Boolean);
    const tags = article
      .find('section')
      .eq(1)
      .find('span')
      .map((__, span) => $(span).text().trim().replace(/,$/, ''))
      .get()
      .filter(Boolean);

    results.push({
      source: 'weebcentral',
      id,
      title,
      slug: slugFromUrl(href),
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      coverUrl: coverUrl(id),
      type: meta[0] || null,
      year: meta[1] || null,
      status: meta[2] || null,
      tags,
    });
  });

  return results;
}

/** One page of results. Weeb Central pages by `offset`. */
async function searchPage(query, { limit = 32, tags = [], page = 1 } = {}) {
  const term = encodeURIComponent(String(query || '').trim());
  // `included_tag` is the same parameter the site's advanced search form posts.
  const included = tags.map((tag) => `&included_tag=${encodeURIComponent(tag)}`).join('');
  const offset = Math.max(0, (page - 1) * limit);
  const url = `${BASE}/search/data?text=${term}&sort=Best+Match&order=Descending&official=Any&display_mode=Minimal+Display&limit=${limit}&offset=${offset}${included}`;
  const items = parseSearchResults(await fetchText(url));
  return { items, hasMore: items.length >= limit };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

function readDetails($) {
  const details = { authors: [], tags: [], associatedNames: [], related: [] };

  $('li').each((_, element) => {
    const item = $(element);
    const label = item.find('strong').first().text().trim().toLowerCase();
    if (!label) return;

    if (label.startsWith('author')) details.authors = item.find('a').map((__, a) => $(a).text().trim()).get().filter(Boolean);
    else if (label.startsWith('tags') || label.startsWith('tag(')) {
      details.tags = item.find('a').map((__, a) => $(a).text().trim()).get().filter(Boolean);
    } else if (label.startsWith('associated name')) {
      details.associatedNames = item.find('ul li').map((__, li) => $(li).text().trim()).get().filter(Boolean);
    } else if (label.startsWith('related series')) {
      details.related = item
        .find('ul li')
        .map((__, li) => {
          const node = $(li);
          const anchor = node.find('a').first();
          return {
            title: anchor.text().trim(),
            url: anchor.attr('href') || '',
            relation: node.find('span').first().text().trim().replace(/[()]/g, ''),
          };
        })
        .get()
        .filter((entry) => entry.title);
    } else if (label.startsWith('type')) details.type = item.find('a').first().text().trim();
    else if (label.startsWith('status')) details.status = item.find('a').first().text().trim();
    else if (label.startsWith('released')) details.released = item.find('span').first().text().trim();
    else if (label.startsWith('official translation')) details.officialTranslation = item.find('a').first().text().trim();
    else if (label.startsWith('anime adaptation')) details.animeAdaptation = item.find('a').first().text().trim();
    else if (label.startsWith('adult content')) details.adultContent = item.find('a').first().text().trim();
  });

  return details;
}

function parseSeries(html, id) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || $('title').text().split('|')[0].trim();

  let description = '';
  $('strong').each((_, element) => {
    const node = $(element);
    if (node.text().trim().toLowerCase() === 'description') {
      description = node.parent().find('p').first().text().trim();
      return false;
    }
    return undefined;
  });

  return {
    source: 'weebcentral',
    id,
    title,
    url: `${BASE}/series/${id}`,
    coverUrl: $('meta[property="og:image"]').attr('content') || coverUrl(id),
    description,
    ...readDetails($),
  };
}

function parseChapters(html) {
  const $ = cheerio.load(html);
  const chapters = [];
  const seen = new Set();

  let rows = $('#chapter-list > div');
  if (!rows.length) rows = $('div.flex.items-center').filter((_, el) => $(el).find('a[href*="/chapters/"]').length > 0);

  rows.each((_, element) => {
    const row = $(element);
    const link = row.find('a[href*="/chapters/"]').first();
    const href = link.attr('href') || '';
    const id = chapterIdFromUrl(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const name = link.find('span.grow > span').first().text().trim() || `Chapter ${chapters.length + 1}`;
    chapters.push({
      source: 'weebcentral',
      id,
      name,
      number: chapterNumberFromName(name),
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      official: link.find('img[src*="chapter-badge-official"]').length > 0,
      publishedAt: link.find('time').attr('datetime') || null,
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

async function getSeries(ref) {
  const id = ref.id || seriesIdFromUrl(ref.url);
  if (!id) throw new Error('That is not a Weeb Central series link.');
  const url = ref.slug ? `${BASE}/series/${id}/${ref.slug}` : `${BASE}/series/${id}`;

  const [seriesHtml, chaptersHtml] = await Promise.all([fetchText(url), fetchText(`${BASE}/series/${id}/full-chapter-list`)]);

  const series = parseSeries(seriesHtml, id);
  const chapters = parseChapters(chaptersHtml);

  return {
    ...series,
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getChapterImages(chapter) {
  const id = chapter.id || chapterIdFromUrl(chapter.url);
  const html = await fetchText(`${BASE}/chapters/${id}/images?is_prev=False&current_page=1&reading_style=long_strip`, {
    headers: { 'HX-Request': 'true' },
  });
  const $ = cheerio.load(html);
  const images = [];
  $('#chapter-images img').each((_, element) => {
    const src = $(element).attr('src');
    if (src && !src.includes('broken_image')) images.push(src.startsWith('http') ? src : `${BASE}${src}`);
  });
  if (!images.length) throw new Error('No pages found for this chapter.');
  return { images, referer: `${BASE}/` };
}

/** Series that appeared in the latest site updates, used for recommendations. */
async function recommendations({ limit = 12 } = {}) {
  const html = await fetchText(BASE);
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('article[data-tip]').each((_, element) => {
    const article = $(element);
    const link = article.find('a[href*="/series/"]').first();
    const href = link.attr('href') || '';
    const id = seriesIdFromUrl(href);
    if (!id || seen.has(id)) return;

    const title = (article.attr('data-tip') || link.attr('data-tip') || link.text() || '').trim();
    const image = article.find('img').first();
    seen.add(id);
    results.push({
      source: 'weebcentral',
      id,
      title: title || 'Untitled',
      slug: slugFromUrl(href),
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      // Some cards ship only a `srcset`; fall back to the deterministic CDN path.
      coverUrl:
        image.attr('src') ||
        (image.attr('srcset') || article.find('source[srcset]').first().attr('srcset') || '')
          .split(',')
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean)[0] ||
        coverUrl(id),
      type: null,
      year: null,
      status: null,
      tags: [],
    });
  });

  return results.filter((entry) => entry.title && entry.title !== 'Untitled').slice(0, limit);
}

/**
 * Trending: the site's own "Hot Series" ranking, weekly + monthly + all-time.
 * The fragment carries titles and links only, so covers come from the CDN.
 */
async function trending({ limit = 24 } = {}) {
  const sorts = ['weekly_views', 'monthly_views', 'total_views'];
  const settled = await Promise.allSettled(sorts.map((sort) => fetchText(`${BASE}/hot-series?sort=${sort}`)));
  const results = [];
  const seen = new Set();

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    const $ = cheerio.load(outcome.value);
    $('a[href*="/series/"]').each((_, element) => {
      const link = $(element);
      const href = link.attr('href') || '';
      const id = seriesIdFromUrl(href);
      if (!id || seen.has(id)) return;
      const title = link.text().trim();
      if (!title) return;
      seen.add(id);
      results.push({
        source: 'weebcentral',
        id,
        title,
        slug: slugFromUrl(href),
        url: href.startsWith('http') ? href : `${BASE}${href}`,
        coverUrl: coverUrl(id),
        type: null,
        year: null,
        status: null,
        tags: [],
      });
    });
  }

  return results.slice(0, limit);
}

async function resolveChapter(chapter) {
  const html = await fetchText(`${BASE}/chapters/${chapter.id}`);
  const $ = cheerio.load(html);
  const id = seriesIdFromUrl($('a[href*="/series/"]').first().attr('href') || '');
  if (!id) throw new Error('Could not find the series for that chapter link.');
  return {id};
}

module.exports = {
  resolveChapter,
  id: 'weebcentral',
  label: 'Weeb Central',
  short: 'WC',
  homepage: BASE,
  hosts: ['weebcentral.com'],
  parseInput,
  seriesIdFromUrl,
  chapterIdFromUrl,
  chapterNumberFromName,
  coverUrl,
  hasTags: true,
  search,
  searchPage,
  getSeries,
  getChapterImages,
  recommendations,
  trending,
  tags,
};
