// [xihanzu-NR]
/**
 * `sitemap.xml` and `robots.txt` from `config.site`.
 *
 * The rule the test exists for: the sitemap lists what the build WROTE, and
 * nothing else. A guarded page whose loader refused, a `csr` route and a dynamic
 * route without `static_params` are not files a crawler can fetch, so listing
 * them would be an assertion the site cannot keep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { writeSitemapAndRobots } = await import('./runner.mjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sitemap-'));
}

test('writes a urlset from the given URLs, with the trailing slash trimmed from site', () => {
  const dir = tmpdir();
  const count = writeSitemapAndRobots(dir, 'https://example.com/', ['/', '/about', '/blog/hello']);
  assert.equal(count, 3);
  const xml = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/about<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/blog\/hello<\/loc>/);
  assert.equal(xml.match(/<url>/g).length, 3);
});

test('de-duplicates by path, so ?q= and #frag do not multiply a page', () => {
  const dir = tmpdir();
  const count = writeSitemapAndRobots(dir, 'https://example.com', [
    '/search?q=a',
    '/search?q=b',
    '/about#team',
    '/about',
  ]);
  assert.equal(count, 2);
  const xml = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  assert.equal(xml.match(/<url>/g).length, 2);
  assert.ok(!xml.includes('?q='));
});

test('escapes XML-hostile characters in the path', () => {
  const dir = tmpdir();
  writeSitemapAndRobots(dir, 'https://example.com', ['/a&b', '/x<y']);
  const xml = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  assert.ok(xml.includes('/a&amp;b'));
  assert.ok(xml.includes('/x&lt;y'));
});

test('writes robots.txt only when the project has not written one', () => {
  const dir = tmpdir();
  writeSitemapAndRobots(dir, 'https://example.com', ['/']);
  const robots = fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*\nAllow: \/\nSitemap: https:\/\/example\.com\/sitemap\.xml\n$/);

  const second = tmpdir();
  fs.writeFileSync(path.join(second, 'robots.txt'), 'User-agent: *\nDisallow: /private\n', 'utf8');
  writeSitemapAndRobots(second, 'https://example.com', ['/']);
  const kept = fs.readFileSync(path.join(second, 'robots.txt'), 'utf8');
  assert.equal(kept, 'User-agent: *\nDisallow: /private\n', 'a project that wrote its own robots.txt keeps it');
});

test('nothing to list means no files at all', () => {
  const dir = tmpdir();
  const count = writeSitemapAndRobots(dir, 'https://example.com', []);
  assert.equal(count, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'sitemap.xml')));
  assert.ok(!fs.existsSync(path.join(dir, 'robots.txt')));
});
