'use strict';

const { createMadara } = require('./madara');

/** Pornhwaz — sister site of Manga Read Z, same Madara markup and paths. */
module.exports = createMadara({
  id: 'pornhwaz',
  label: 'Pornhwaz',
  short: 'PHW',
  homepage: 'https://www.pornhwaz.com',
  hosts: ['pornhwaz.com'],
  seriesPath: '/webtoon/',
  genrePath: '/webtoon-genre/',
  genreIndexUrl: 'https://www.pornhwaz.com/?s=&post_type=wp-manga',
  genreBlocklist: ['webtoon-genre'],
});
