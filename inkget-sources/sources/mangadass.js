'use strict';
const {createMangaStream}=require('./mangastream');
module.exports=createMangaStream({id:'mangadass',label:'MangaDass',short:'MDS',homepage:'https://mangadass.com',hosts:['mangadass.com'],seriesPath:'/manga/',genrePath:'/manga-genre/'});
