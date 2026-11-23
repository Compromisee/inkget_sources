'use strict';

const { createMadara } = require('./madara');

/** Manga Read Z — Madara site whose serials live under /webtoon/. */
module.exports = createMadara({
  id: 'mangareadz',
  label: 'Manga Read Z',
  short: 'MRZ',
  homepage: 'https://www.mangareadz.com',
  hosts: ['mangareadz.com'],
  seriesPath: '/webtoon/',
  genrePath: '/webtoon-genre/',
  genreIndexUrl: 'https://www.mangareadz.com/?s=&post_type=wp-manga',
  genreBlocklist: ['webtoon-genre'],
});
