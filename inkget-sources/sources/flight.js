'use strict';
const cheerio = require('cheerio');
function flightChunks(html) {
  const $=cheerio.load(html), result=[];
  $('script:not([src])').each((_,el)=>{ const m=($(el).html()||'').trim().match(/^self\.__next_f\.push\((.*)\)\s*;?$/s); if(!m)return; try { const x=JSON.parse(m[1]); if(typeof x[1]==='string')result.push(x[1]); } catch {} });
  return result;
}
function arraysFor(html, property) {
  const result=[], needle=`"${property}":`;
  for(const chunk of flightChunks(html)) { let pos=0; while((pos=chunk.indexOf(needle,pos))>=0) {
    let start=pos+needle.length;while(/\s/.test(chunk[start]||''))start++;if(chunk[start]!=='['){pos=start+1;continue;}
    let depth=0,str=false,escaped=false,end=-1;
    for(let i=start;i<chunk.length;i++){let c=chunk[i];if(str){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')str=false;continue;}if(c==='"')str=true;else if(c==='[')depth++;else if(c===']'&&--depth===0){end=i+1;break;}}
    if(end<0)break;try{let x=JSON.parse(chunk.slice(start,end));if(Array.isArray(x))result.push(x)}catch{}pos=end;
  }} return result;
}
module.exports={flightChunks,arraysFor};
