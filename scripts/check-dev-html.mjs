// [xihanzu-NR]
/** Which HTML does the dev server actually answer with, and does it carry HMR? */
const res = await fetch(process.argv[2] || 'http://127.0.0.1:4530/');
const html = await res.text();
console.log('status', res.status, 'len', html.length);
for (const k of ['__hydra/hmr', '__hydra_entry', 'assets/index-']) {
  console.log(k, '->', html.includes(k));
}
const m = /<script[^>]*src="([^"]*assets\/index-[^"]+)"/.exec(html);
console.log('entry tag:', m && m[1]);
