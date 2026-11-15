'use strict';

/**
 * Manga18 — server-rendered catalogue.
 *
 * Search is `/list-manga?search=<q>`, categories are `/manga-list/<Category>`,
 * chapter lists live in `.chapter_box`, and a chapter's pages are base64-encoded
 * URLs inside `var slides_p_path = [...]`.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const BASE = 'https://manga18.club';
const CDN = 'https://cdn.manga18.club';

const seriesUrl = (slug) => `${BASE}/manhwa/${slug}`;
const chapterUrl = (slug, chapter) => `${BASE}/manhwa/${slug}/${chapter}`;

function absolute(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return `${BASE}${value.startsWith('/') ? '' : '/'}${value}`;
}

function parseInput(text = '') {
  const value = String(text).trim();
  const chapter = value.match(/manga18\.club\/manhwa\/([a-z0-9-]+)\/(chapter-[\w-]+)/i);
  if (chapter) {
    return {
      type: 'chapter',
      source: 'manga18',
      id: `${chapter[1]}/${chapter[2]}`,
      slug: chapter[1],
      url: chapterUrl(chapter[1], chapter[2]),
    };
  }
  const series = value.match(/manga18\.club\/manhwa\/([a-z0-9-]+)/i);
  if (series) {
    return { type: 'series', source: 'manga18', id: series[1], slug: series[1], url: seriesUrl(series[1]) };
  }
  return null;
}

const slugFromUrl = (url = '') => String(url).match(/\/manhwa\/([a-z0-9-]+)/i)?.[1] || null;

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('.story_item').each((_, element) => {
    const card = $(element);
    const link = card.find('.mg_name a').first().length
      ? card.find('.mg_name a').first()
      : card.find('a[href*="/manhwa/"]').first();
    const href = link.attr('href') || '';
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);

    const image = card.find('.story_images img').first();
    const cover =
      image.attr('src') ||
      image.attr('data-src') ||
      `${CDN}/manga/${slug}/cover/cover_thumb_2.webp`;

    const tags = card
      .find('.mg_info a[href*="manga-list"], .mg_tags a')
      .map((__, anchor) => $(anchor).text().trim())
      .get()
      .filter(Boolean);

    results.push({
      source: 'manga18',
      id: slug,
      slug,
      title: (link.text() || image.attr('alt') || slug).trim().replace(/\s+/g, ' '),
      url: absolute(href) || seriesUrl(slug),
      coverUrl: absolute(cover),
      type: 'Manhwa',
      year: null,
      status: card.find('.mg_status, .status').first().text().trim() || null,
      tags: [...new Set(tags)].slice(0, 8),
      latestChapter: card.find('.mg_chapter a').last().text().trim() || null,
    });
  });

  return results;
}

async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
  const text = String(query || '').trim();
  const category = wanted && wanted.length ? String(wanted[0]) : '';
  const params = new URLSearchParams();

  let path;
  if (!text && category) {
    // Browse one category: /manga-list/<Category>
    path = `${BASE}/manga-list/${encodeURIComponent(category)}`;
  } else {
    path = `${BASE}/list-manga/`;
    if (text) params.set('search', text);
    if (category) params.set('category', category);
  }
  if (page > 1) params.set('page', String(page));

  const url = params.toString() ? `${path}?${params.toString()}` : path;
  const html = await fetchText(url);
  const all = parseCards(html);
  const results = all.slice(0, limit);
  // The pager only prints page links when another page exists.
  const hasMore = new RegExp(`page=${page + 1}(?![0-9])`).test(html);
  return { items: results, hasMore };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* --------------------------------------------------------------- tags -- */

let tagCache = null;

async function tags() {
  if (tagCache && Date.now() - tagCache.at < 60 * 60 * 1000) return tagCache.tags;
  const html = await fetchText(`${BASE}/manga-list/raw`);
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href*="/manga-list/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const slug = href.match(/\/manga-list\/([^/?#]+)/i)?.[1];
    if (!slug) return;
    const name = ($(anchor).text() || slug).trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) return;
    const key = slug.toLowerCase();
    if (seen.has(key)) return;
    seen.set(key, { name, slug });
  });

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  tagCache = { at: Date.now(), tags: list };
  return list;
}

/* ------------------------------------------------------------- series -- */

async function getSeries(ref = {}) {
  const slug = ref.slug || ref.id || slugFromUrl(ref.url || '');
  if (!slug) throw new Error('That is not a Manga18 series link.');
  const html = await fetchText(seriesUrl(slug));
  const $ = cheerio.load(html);

  const title =
    $('.manga_info .name, .detail_name h1, h1').first().text().trim().replace(/\s+/g, ' ') ||
    $('meta[property="og:title"]').attr('content') ||
    slug;

  const description =
    $('.manga_info .content, .detail_content, .summary_content').first().text().trim().replace(/\s+/g, ' ') || '';

  const infoValue = (label) => {
    let value = '';
    $('.info_label').each((_, element) => {
      const text = $(element).text().trim().toLowerCase();
      if (!text.includes(label)) return;
      value = $(element).next('.info_value').text().trim().replace(/\s+/g, ' ');
    });
    return value;
  };

  const genreNames = $('.info_value a[href*="/manga-list/"]')
    .map((_, anchor) => $(anchor).text().trim())
    .get()
    .filter(Boolean);

  const authors = $('.info_value a[href*="author="]')
    .map((_, anchor) => $(anchor).text().trim())
    .get()
    .filter(Boolean);

  const chapters = [];
  const seen = new Set();
  $('.chapter_box li a, .chapter_box a[href*="chapter-"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const token = href.match(/chapter-([\w-]+)/i)?.[1];
    if (!token || seen.has(token)) return;
    seen.add(token);
    const name = $(anchor).text().trim().replace(/\s+/g, ' ') || `Chapter ${token}`;
    const number = Number(String(name).replace(/[^\d.]/g, '')) || Number(token.replace(/[^\d.]/g, '')) || null;
    chapters.push({
      source: 'manga18',
      id: token,
      name,
      number,
      url: absolute(href),
      official: false,
      publishedAt: $(anchor).closest('li').find('.chapter_info').first().text().trim() || null,
    });
  });

  chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const cover =
    $('.manga_info img, .detail_avatar img').first().attr('src') ||
    `${CDN}/manga/${slug}/cover/cover_thumb.jpg`;

  return {
    source: 'manga18',
    id: slug,
    slug,
    title: title.replace(/\s*Manga\s*-\s*Read.*$/i, '').trim(),
    url: seriesUrl(slug),
    coverUrl: absolute(cover),
    description: description.slice(0, 1200),
    authors,
    associatedNames: [],
    tags: [...new Set(genreNames)].slice(0, 12),
    type: 'Manhwa',
    status: infoValue('status') || null,
    released: infoValue('released') || null,
    officialTranslation: null,
    animeAdaptation: null,
    adultContent: 'Yes',
    related: [],
    chapters,
    chapterCount: chapters.length,
    latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------ chapter -- */

async function getChapterImages(chapter = {}) {
  const html = await fetchText(chapter.url);
  const match = html.match(/slides_p_path\s*=\s*\[([\s\S]*?)\]/);
  const images = [];

  if (match) {
    for (const raw of match[1].split(',')) {
      const token = raw.trim().replace(/^["']|["']$/g, '');
      if (!token) continue;
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8').trim();
        if (/^https?:\/\//i.test(decoded) && !images.includes(decoded)) images.push(decoded);
      } catch {
        /* skip a malformed entry rather than failing the chapter */
      }
    }
  }

  if (!images.length) {
    // Fall back to the chapter's own <img> tags.
    const $ = cheerio.load(html);
    $('.chapter_content img, .reading-content img, .content_chap img').each((_, image) => {
      const src = ($(image).attr('data-src') || $(image).attr('src') || '').trim();
      if (!src || /^data:image\//i.test(src)) return;
      const url = absolute(src);
      if (url && !images.includes(url)) images.push(url);
    });
  }

  if (!images.length) throw new Error('No pages found for this chapter.');
  return { images, referer: `${BASE}/` };
}

/* --------------------------------------------------- trending + picks -- */

async function trending({ limit = 24 } = {}) {
  const html = await fetchText(`${BASE}/list-manga/?order_by=views`);
  return parseCards(html).slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  const html = await fetchText(`${BASE}/list-manga/`);
  return parseCards(html).slice(0, limit);
}

module.exports = {
  id: 'manga18',
  label: 'Manga18',
  short: 'M18',
  homepage: BASE,
  hosts: ['manga18.club'],
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
