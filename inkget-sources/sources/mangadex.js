'use strict';

/**
 * MangaDex — a public API, and the only source here with a documented one.
 *
 *   GET https://api.mangadex.org/manga?title=&limit=&offset=&includes[]=cover_art
 *   GET https://api.mangadex.org/manga/<id>?includes[]=cover_art&includes[]=author
 *   GET https://api.mangadex.org/manga/<id>/feed?translatedLanguage[]=en
 *   GET https://api.mangadex.org/at-home/server/<chapter-id>
 *   GET https://api.mangadex.org/manga/tag
 *   GET https://api.mangadex.org/statistics/manga?manga[]=<id>
 *
 * Three details from the reference are load-bearing and easy to get wrong:
 *
 *  1. Array parameters are written with brackets — `contentRating[]=safe`. Send
 *     `contentRating=safe` instead and the API answers 400
 *     ("String value found, but an array is required") rather than ignoring it.
 *  2. Covers are not on the manga object. The API hands back a `cover_art`
 *     relationship whose `attributes.fileName` is half a URL; the cover lives at
 *     `https://uploads.mangadex.org/covers/<manga-id>/<fileName>.512.jpg`
 *     (`.256.jpg`, `.512.jpg`, `.1024.jpg` are the documented sizes).
 *  3. Pages are not on the chapter either. `/at-home/server/<chapter>` returns a
 *     `baseUrl`, a `hash` and the file names, and a page is
 *     `<baseUrl>/data/<hash>/<file>` (or `/data-saver/` for the small version).
 *     That URL expires, so it is resolved per read instead of being stored.
 *
 * The API asks for an identifying User-Agent and asks callers to stay inside
 * five requests a second, which is why every call here goes through one queue.
 */

const { fetchText } = require('../http');

const API = 'https://api.mangadex.org';
const SITE = 'https://mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';

// The reference asks for a descriptive agent with a way to make contact.
const UA = 'Inkget/0.5 (+https://github.com/Compromisee/inkget)';

const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
const LANGUAGES = ['en', 'ja', 'ko', 'zh', 'es', 'fr', 'de', 'pt-br', 'ru', 'it'];

/* ------------------------------------------------------------------ http -- */

/**
 * One request at a time, ~200 ms apart: the documented limit is five per second
 * per IP and a 429 costs the user every result on the page.
 */
const GAP = 200;
let chain = Promise.resolve();
let lastAt = 0;

function json(path, params = {}) {
  const url = new URL(`${API}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    // Bracketed keys are the API's own array syntax and must not be re-encoded.
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
    else url.searchParams.set(key, String(value));
  });

  const run = async () => {
    const wait = lastAt + GAP - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
    const text = await fetchText(url.toString(), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('MangaDex sent something that is not JSON.');
    }
  };

  const next = chain.then(run, run);
  chain = next.catch(() => null);
  return next;
}

/* --------------------------------------------------------------- mapping -- */

const localTitle = (titles = {}) => titles.en || titles['ja-ro'] || Object.values(titles)[0] || 'Untitled';

const fileNameOf = (manga) =>
  (manga.relationships || []).find((rel) => rel.type === 'cover_art')?.attributes?.fileName || null;

/** The documented cover path. `size` is one of '', '.256', '.512', '.1024'. */
const coverUrl = (manga, size = '.512') => {
  const file = fileNameOf(manga);
  if (!file) return null;
  return `${UPLOADS}/covers/${manga.id}/${file}${size}.jpg`;
};

const authorsOf = (manga, type) =>
  (manga.relationships || [])
    .filter((rel) => rel.type === type && rel.attributes?.name)
    .map((rel) => rel.attributes.name);

const tagName = (tag) => tag?.attributes?.name?.en || Object.values(tag?.attributes?.name || {})[0] || '';

/** Tag names are the searchable labels; the group is kept for the tag panel. */
function tagsOf(manga) {
  return (manga.attributes?.tags || [])
    .map((tag) => ({ name: tagName(tag), group: tag?.attributes?.group || 'genre' }))
    .filter((tag) => tag.name);
}

function toItem(manga) {
  const attrs = manga.attributes || {};
  const tags = tagsOf(manga);
  return {
    source: 'mangadex',
    id: manga.id,
    slug: manga.id,
    title: localTitle(attrs.title).trim(),
    url: `${SITE}/title/${manga.id}`,
    coverUrl: coverUrl(manga),
    type: attrs.publicationDemographic ? titleCase(attrs.publicationDemographic) : titleCase(attrs.originalLanguage === 'ja' ? 'Manga' : 'Manhwa'),
    status: attrs.status ? titleCase(String(attrs.status).replace(/_/g, ' ')) : null,
    year: attrs.year || null,
    rating: null,
    tags: tags.map((tag) => tag.name).slice(0, 12),
    chapterCount: null,
    latestChapter: null,
    language: attrs.originalLanguage || null,
    contentRating: attrs.contentRating || null,
  };
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

/* ---------------------------------------------------------------- search -- */

/** `https://mangadex.org/title/<uuid>/<slug>` — the slug is decoration. */
function parseInput(text = '') {
  const value = String(text).trim();
  const url = value.match(/mangadex\.org\/title\/([0-9a-f-]{36})/i);
  if (url) return { type: 'series', source: 'mangadex', id: url[1], slug: url[1] };
  const chapter = value.match(/mangadex\.org\/chapter\/([0-9a-f-]{36})/i);
  if (chapter) return { type: 'chapter', source: 'mangadex', id: chapter[1], slug: chapter[1] };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return { type: 'series', source: 'mangadex', id: value, slug: value };
  }
  return null;
}

/** Tag labels → uuids, so a tag chip filters on the API rather than in memory. */
let tagIndex = { at: 0, byName: new Map() };

async function tagDirectory() {
  if (tagIndex.byName.size && Date.now() - tagIndex.at < 1000 * 60 * 60 * 24) return tagIndex;
  const payload = await json('/manga/tag');
  const byName = new Map();
  (payload?.data || []).forEach((tag) => {
    const name = tagName(tag);
    if (name) byName.set(name.toLowerCase(), { id: tag.id, name, group: tag.attributes?.group || 'genre' });
  });
  tagIndex = { at: Date.now(), byName };
  return tagIndex;
}

const stripPrefix = (tag) => String(tag).replace(/^(?:genre|theme|format|content|tag):/i, '').trim();

async function resolveTagIds(wanted = []) {
  if (!wanted.length) return [];
  const { byName } = await tagDirectory();
  return wanted
    .map((tag) => byName.get(stripPrefix(tag).toLowerCase())?.id || null)
    .filter(Boolean);
}

/**
 * Search.
 *
 * `includedTags` is AND by default — which is what several tags at once has to
 * mean — and the mode is sent explicitly so a future change on their side cannot
 * quietly turn it into OR.
 */
async function searchPage(query, { limit = 24, tags = [], language = 'english', page = 1 } = {}) {
  const offset = Math.max(0, (Math.max(1, page) - 1) * limit);
  const tagIds = await resolveTagIds(tags);
  // Every selected tag has to exist on their side; a tag they do not know would
  // otherwise be dropped and quietly widen the search.
  if (tags.length && tagIds.length !== tags.filter((tag) => stripPrefix(tag)).length) {
    return { items: [], hasMore: false };
  }

  const params = {
    title: String(query || '').trim() || undefined,
    limit: Math.min(100, Math.max(1, limit)),
    offset,
    'includes[]': ['cover_art', 'author', 'artist'],
    'contentRating[]': CONTENT_RATINGS,
    'order[relevance]': 'desc',
    'includedTags[]': tagIds.length ? tagIds : undefined,
    includedTagsMode: tagIds.length ? 'AND' : undefined,
    'availableTranslatedLanguage[]': language && language !== 'any' ? [languageCode(language)] : undefined,
  };

  const payload = await json('/manga', params);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const readable = await readableOnly(rows);
  const items = readable.map(toItem).slice(0, limit);
  const total = Number(payload?.total) || 0;
  return { items, hasMore: offset + rows.length < total };
}

/* ------------------------------------------------------- readable titles -- */

/**
 * A MangaDex record can exist without a single page behind it: an entry whose
 * chapters are all `externalUrl` links to another site. Those cards open a page
 * with no chapters, which is a dead end for a reader. `attributes.lastChapter`
 * is a number whenever the title has numbered chapters, so only the rows
 * without one are worth asking about — one tiny `limit=1` request each, cached
 * for the session.
 */
const readableCache = new Map();

async function hasReadableChapter(id) {
  if (readableCache.has(id)) return readableCache.get(id);
  try {
    const payload = await json('/chapter', { manga: id, 'translatedLanguage[]': ['en'], limit: 1 });
    const ok = Number(payload?.total) > 0;
    readableCache.set(id, ok);
    return ok;
  } catch {
    // A failed check must not hide a title that is probably fine.
    return true;
  }
}

async function readableOnly(rows) {
  const unnumbered = rows.filter((row) => !String(row?.attributes?.lastChapter ?? '').trim());
  if (!unnumbered.length) return rows;
  const verdicts = await Promise.all(unnumbered.map((row) => hasReadableChapter(row.id)));
  const bad = new Set(unnumbered.filter((_, index) => verdicts[index] === false).map((row) => row.id));
  return rows.filter((row) => !bad.has(row.id));
}

const languageCode = (value) => {
  const lower = String(value || '').toLowerCase();
  if (lower === 'japanese' || lower === 'ja') return 'ja';
  if (lower === 'korean' || lower === 'ko') return 'ko';
  if (lower === 'chinese' || lower === 'zh') return 'zh';
  return 'en';
};

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/* ------------------------------------------------------------------ tags -- */

async function tags() {
  const { byName } = await tagDirectory();
  return [...byName.values()]
    .map((tag) => ({ name: tag.name, slug: tag.name, namespace: tag.group }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------- series -- */

async function feed(mangaId, language) {
  const lang = languageCode(language);
  const chapters = [];
  let offset = 0;
  // The endpoint answers at most 500 at a time; long-running series need a walk.
  for (let page = 0; page < 8; page += 1) {
    const payload = await json(`/manga/${mangaId}/feed`, {
      'translatedLanguage[]': [lang],
      'order[chapter]': 'asc',
      'includes[]': ['scanlation_group'],
      limit: 500,
      offset,
    });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    chapters.push(...rows);
    const total = Number(payload?.total) || 0;
    offset += rows.length;
    if (!rows.length || offset >= total) break;
  }

  // Chapters hosted elsewhere have no pages to read; the count is reported in the
  // description instead of listing rows that cannot open.
  const readable = chapters.filter((chapter) => !chapter.attributes.externalUrl && Number(chapter.attributes.pages) > 0);
  const external = chapters.length - readable.length;

  // The feed lists every scanlation group's upload of the same chapter, so a
  // series would otherwise show three versions of chapter 12. Keep the longest
  // upload of each numbered chapter, newest first on a tie.
  const byNumber = new Map();
  readable.forEach((chapter) => {
    const attrs = chapter.attributes;
    const key = `${attrs.volume || ''}|${attrs.chapter || ''}`;
    const entry = {
      source: 'mangadex',
      id: chapter.id,
      name: chapterName(attrs),
      number: attrs.chapter && Number.isFinite(Number(attrs.chapter)) ? Number(attrs.chapter) : null,
      volume: attrs.volume || null,
      url: `${SITE}/chapter/${chapter.id}`,
      official: false,
      publishedAt: attrs.publishAt || attrs.readableAt || null,
      pages: Number(attrs.pages) || null,
      language: attrs.translatedLanguage || null,
      group:
        (chapter.relationships || []).find((rel) => rel.type === 'scanlation_group')?.attributes?.name || null,
    };
    const current = byNumber.get(key);
    if (!current) {
      byNumber.set(key, entry);
      return;
    }
    const better =
      (entry.pages || 0) > (current.pages || 0) ||
      ((entry.pages || 0) === (current.pages || 0) && String(entry.publishedAt) > String(current.publishedAt));
    if (better) byNumber.set(key, entry);
  });

  const list = [...byNumber.values()];
  list.sort((a, b) => {
    if (a.number == null && b.number == null) return 0;
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number;
  });
  return { chapters: list, external };
}

function chapterName(attrs) {
  const number = attrs.chapter ? `Ch. ${attrs.chapter}` : attrs.volume ? `Vol. ${attrs.volume}` : 'Oneshot';
  return attrs.title ? `${number} — ${attrs.title}` : number;
}

async function getSeries(ref = {}) {
  const id = ref.id || parseInput(ref.url || '')?.id;
  if (!id) throw new Error('That is not a MangaDex title link.');

  const [detail, chapterList, stats] = await Promise.all([
    json(`/manga/${id}`, { 'includes[]': ['cover_art', 'author', 'artist', 'tag'] }),
    feed(id, ref.language).catch(() => ({ chapters: [], external: 0 })),
    json('/statistics/manga', { 'manga[]': [id] }).catch(() => null),
  ]);

  const manga = detail?.data;
  if (!manga) throw new Error('MangaDex did not return that title.');

  const attrs = manga.attributes || {};
  const tags = tagsOf(manga);
  const description =
    attrs.description?.en || Object.values(attrs.description || {})[0] || '';

  const rating = Number(stats?.statistics?.[id]?.rating?.bayesian);
  const item = toItem(manga);

  // Nothing to read is not a series: say so plainly instead of opening a page
  // with an empty chapter list.
  if (!chapterList.chapters.length) {
    readableCache.set(id, false);
    throw new Error('MangaDex has no readable English chapters for this title.');
  }

  return {
    ...item,
    title: localTitle(attrs.title).trim(),
    description: String(description).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim(),
    authors: [...authorsOf(manga, 'author'), ...authorsOf(manga, 'artist')],
    associatedNames: [
      ...new Set((attrs.altTitles || []).map((entry) => Object.values(entry)[0]).filter(Boolean)),
    ].slice(0, 12),
    tags: [...new Set([...tags.map((tag) => tag.name), ...(attrs.publicationDemographic ? [titleCase(attrs.publicationDemographic)] : [])])],
    status: attrs.status ? titleCase(attrs.status) : null,
    released: attrs.year ? String(attrs.year) : null,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    language: attrs.originalLanguage ? String(attrs.originalLanguage).toUpperCase() : null,
    contentRating: attrs.contentRating || null,
    downloadable: true,
    chapters: chapterList.chapters,
    chapterCount: chapterList.chapters.length,
    externalChapters: chapterList.external,
    latestChapter: chapterList.chapters.length ? chapterList.chapters[chapterList.chapters.length - 1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * A chapter's pages.
 *
 * `/at-home/server` is resolved at read time because its base URL expires; the
 * file list it returns is the only place the page names exist.
 */
async function getChapterImages(chapter = {}) {
  const id = chapter.id || String(chapter.url || '').match(/chapter\/([0-9a-f-]{36})/i)?.[1];
  if (!id) throw new Error('That is not a MangaDex chapter.');

  const payload = await json(`/at-home/server/${id}`);
  const base = payload?.baseUrl;
  const hash = payload?.chapter?.hash;
  const files = payload?.chapter?.data || [];
  if (!base || !hash || !files.length) throw new Error('MangaDex has no pages for that chapter.');

  const images = files.map((file) => `${base}/data/${hash}/${file}`);
  // The small renditions are what the thumbnail strip wants: a 40-page chapter
  // drawn at 48 px should not cost 40 full pages of bandwidth.
  const small = payload?.chapter?.dataSaver || [];
  const thumbs = small.length === files.length ? small.map((file) => `${base}/data-saver/${hash}/${file}`) : [];
  return { images, thumbs, referer: `${SITE}/`, quality: 'data' };
}

/* ------------------------------------------------------------- discovery -- */

async function trending({ limit = 24 } = {}) {
  const payload = await json('/manga', {
    limit: Math.min(100, Math.max(1, limit)),
    'order[followedCount]': 'desc',
    'includes[]': ['cover_art', 'author', 'artist'],
    'contentRating[]': CONTENT_RATINGS,
    'availableTranslatedLanguage[]': ['en'],
  });
  return (payload?.data || []).map(toItem).slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  const payload = await json('/manga', {
    limit: Math.min(100, Math.max(1, limit)),
    'order[rating]': 'desc',
    'includes[]': ['cover_art', 'author', 'artist'],
    'contentRating[]': CONTENT_RATINGS,
    'availableTranslatedLanguage[]': ['en'],
  });
  return (payload?.data || []).map(toItem).slice(0, limit);
}

module.exports = {
  id: 'mangadex',
  label: 'MangaDex',
  short: 'MDX',
  homepage: SITE,
  hosts: ['mangadex.org'],
  hasTags: true,
  // Page hosts and the cover CDN refuse Node's fetch but serve Chromium, so the
  // app loads these images directly instead of proxying them.
  imageMode: 'direct',
  parseInput,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  trending,
  recommendations,
};
