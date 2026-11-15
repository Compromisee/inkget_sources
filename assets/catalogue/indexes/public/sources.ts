// Public repository catalogue; paths are relative to sources.json.
export const sources = [
  {
    "id": "chikari",
    "name": "Chikari",
    "homepage": "https://chikari.moe",
    "module": "sources/chikari.js",
    "hidden": false
  },
  {
    "id": "mangadex",
    "name": "MangaDex",
    "homepage": "https://mangadex.org",
    "module": "sources/mangadex.js",
    "hidden": false
  },
  {
    "id": "mangakatana",
    "name": "MangaKatana",
    "homepage": "https://mangakatana.com",
    "module": "sources/mangakatana.js",
    "hidden": false
  },
  {
    "id": "webtoons",
    "name": "WEBTOON",
    "homepage": "https://www.webtoons.com",
    "module": "sources/webtoons.js",
    "hidden": false
  },
  {
    "id": "weebcentral",
    "name": "Weeb Central",
    "homepage": "https://weebcentral.com",
    "module": "sources/weebcentral.js",
    "hidden": false
  }
] as const;
