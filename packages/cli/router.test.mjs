// [xihanzu-NR]
/**
 * Tests for file-based route discovery.
 *
 * The fixtures are written to a temp directory rather than committed as a tree,
 * because the interesting cases are the ones a committed tree cannot show: two
 * files that disagree about a parameter name, a malformed bracket, a folder
 * that is private. Those are the failures that used to be silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanRoutes,
  matchRoute,
  routesModuleSource,
  routeTable,
  routesJson,
  layoutChainFor,
} from './router.mjs';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-routes-'));
  const pages = path.join(dir, 'pages');
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(pages, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body ?? '# [xihanzu-NR]\n', 'utf8');
  }
  fs.mkdirSync(pages, { recursive: true });
  return pages;
}

test('a page file becomes a route, most specific first', () => {
  const pages = fixture({
    'index.hyx': '',
    'about.hyx': '',
    'blog/index.hyx': '',
    'blog/[slug].hyx': '',
  });
  const table = scanRoutes(pages);
  const patterns = table.routes.map((r) => r.pattern).sort();
  assert.deepEqual(patterns, ['/', '/about', '/blog', '/blog/:slug']);
});

test('index.hyx is the folder page, and a folder without one is not a route', () => {
  const pages = fixture({ 'blog/index.hyx': '', 'blog/other.hyx': '', 'empty/.keep': '' });
  const table = scanRoutes(pages);
  const patterns = table.routes.map((r) => r.pattern).sort();
  assert.deepEqual(patterns, ['/blog', '/blog/other']);
});

test('catch-all and optional catch-all parse, and differ only in the trailing marker', () => {
  const pages = fixture({ 'docs/[...rest].hyx': '', 'files/[[...rest]].hyx': '' });
  const table = scanRoutes(pages);
  const byPattern = Object.fromEntries(table.routes.map((r) => [r.pattern, r]));
  assert.ok(byPattern['/docs/*'], 'required catch-all present');
  assert.ok(byPattern['/files/*?'], 'optional catch-all present');
  assert.deepEqual(byPattern['/docs/*'].params, ['rest']);
});

test('a route group does not appear in the URL but still scopes its layouts', () => {
  const pages = fixture({
    '(marketing)/price.hyx': '',
    '(marketing)/_layout.hyx': '',
    'dashboard/_layout.hyx': '',
    'dashboard/index.hyx': '',
  });
  const table = scanRoutes(pages);
  const price = table.routes.find((r) => r.pattern === '/price');
  assert.ok(price, 'group omitted from the URL');
  // `dir` keeps the group, because a group exists precisely to give its routes
  // a layout of their own.
  assert.equal(price.dir, '(marketing)');
  assert.deepEqual(layoutChainFor('(marketing)', table), ['(marketing)/_layout.hyx']);
  // A route with no layout above it gets an empty chain, not a fallback.
  assert.deepEqual(layoutChainFor('nowhere', table), []);
});

test('a leading underscore is private: not routable, and not an error', () => {
  const pages = fixture({
    'index.hyx': '',
    '_partials/Hero.hyx': '',
    '_helpers/thing.hyx': '',
  });
  const table = scanRoutes(pages);
  assert.deepEqual(table.routes.map((r) => r.pattern), ['/']);
  assert.deepEqual(table.errors_diagnostics, []);
});

test('_layout, _404 and _error are collected, at every level', () => {
  const pages = fixture({
    '_layout.hyx': '',
    '_404.hyx': '',
    'shop/_layout.hyx': '',
    'shop/_error.hyx': '',
    'shop/index.hyx': '',
  });
  const table = scanRoutes(pages);
  assert.equal(table.layouts[''], '_layout.hyx');
  assert.equal(table.layouts['shop'], 'shop/_layout.hyx');
  assert.deepEqual(table.notFound.map((n) => n.file), ['_404.hyx']);
  assert.deepEqual(table.errors.map((e) => e.file), ['shop/_error.hyx']);
});

test('two param names in one position is an error naming both files, not a silent winner', () => {
  const pages = fixture({ 'blog/[slug].hyx': '', 'blog/[id].hyx': '' });
  const table = scanRoutes(pages);
  assert.equal(table.errors_diagnostics.length, 1);
  const msg = table.errors_diagnostics[0];
  assert.match(msg, /blog\/\[id\]\.hyx/);
  assert.match(msg, /blog\/\[slug\]\.hyx/);
});

test('the same param name twice in one position is fine', () => {
  const pages = fixture({ 'a/[slug].hyx': '', 'b/[slug].hyx': '' });
  const table = scanRoutes(pages);
  assert.deepEqual(table.errors_diagnostics, []);
});

test('a malformed bracket is reported, not treated as a literal folder name', () => {
  const pages = fixture({ '[slug.hyx': '', 'ok/normal.hyx': '' });
  const table = scanRoutes(pages);
  assert.equal(table.errors_diagnostics.length, 1);
  assert.match(table.errors_diagnostics[0], /\[slug\.hyx/);
});

test('no pages directory is not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-routes-'));
  const table = scanRoutes(path.join(dir, 'pages'));
  assert.deepEqual(table.routes, []);
  assert.deepEqual(table.errors_diagnostics, []);
});

test('matching: literal beats param beats catch-all', () => {
  const pages = fixture({
    'blog/index.hyx': '',
    'blog/[slug].hyx': '',
    'blog/[...rest].hyx': '',
  });
  const { routes } = scanRoutes(pages);

  assert.equal(matchRoute('/blog', routes).route.pattern, '/blog');
  assert.equal(matchRoute('/blog/hello', routes).route.pattern, '/blog/:slug');
  assert.deepEqual(matchRoute('/blog/hello', routes).params, { slug: 'hello' });
  // Two segments cannot be one param, so the catch-all takes it.
  assert.equal(matchRoute('/blog/a/b/c', routes).route.pattern, '/blog/*');
  assert.deepEqual(matchRoute('/blog/a/b/c', routes).params, { rest: ['a', 'b', 'c'] });
});

test('matching: a required catch-all needs at least one segment, an optional one does not', () => {
  const pages = fixture({ 'docs/[...rest].hyx': '', 'files/[[...rest]].hyx': '' });
  const { routes } = scanRoutes(pages);
  assert.equal(matchRoute('/docs', routes), null);
  assert.ok(matchRoute('/docs/a', routes));
  assert.ok(matchRoute('/files', routes));
  assert.deepEqual(matchRoute('/files', routes).params, { rest: [] });
});

test('matching: trailing slash and percent-encoding are normalised', () => {
  const pages = fixture({ 'blog/[slug].hyx': '' });
  const { routes } = scanRoutes(pages);
  assert.deepEqual(matchRoute('/blog/hello%20world/', routes).params, { slug: 'hello world' });
});

test('matching: nothing matches a URL that has no route', () => {
  const pages = fixture({ 'index.hyx': '', 'about.hyx': '' });
  const { routes } = scanRoutes(pages);
  assert.equal(matchRoute('/nope', routes), null);
  assert.equal(matchRoute('/about/deeper', routes), null);
});

test('the generated module imports its pages STATICALLY', () => {
  const pages = fixture({ 'index.hyx': '', 'blog/[slug].hyx': '' });
  const table = scanRoutes(pages);
  const src = routesModuleSource(table, { base: '/sub/' });
  assert.match(src, /export const routes =/);
  assert.match(src, /export const base = "\/sub\/";/);
  assert.match(src, /export default/);
  // Static imports, NOT `() => import(...)`. The lazy form is compiled by
  // esbuild into a chunk the entry never references, which is how `Router`
  // disappeared from the client bundle while the build reported success.
  assert.match(src, /^import \* as __route_/m);
  assert.doesNotMatch(src, /\(\) => import\(/);
  assert.doesNotMatch(src, /await/);
});

test('hydra routes table lists dynamic routes and framework files', () => {
  const pages = fixture({
    'index.hyx': '',
    'blog/[slug].hyx': '',
    '_layout.hyx': '',
    '_404.hyx': '',
  });
  const table = scanRoutes(pages);
  const text = routeTable(table);
  assert.match(text, /\/blog\/:slug\s+dynamic\s+src\/pages\/blog\/\[slug\]\.hyx/);
  assert.match(text, /\/\s+static\s+src\/pages\/index\.hyx/);
  assert.match(text, /layout/);
  assert.match(text, /404/);
});

test('routes json is tooling-shaped', () => {
  const pages = fixture({ 'dashboard/index.hyx': '', 'dashboard/_layout.hyx': '' });
  const table = scanRoutes(pages);
  const json = routesJson(table);
  assert.equal(json.routes.length, 1);
  assert.equal(json.routes[0].pattern, '/dashboard');
  assert.equal(json.routes[0].dynamic, false);
  assert.deepEqual(json.routes[0].layouts, ['dashboard/_layout.hyx']);
});

test('the same folder scanned twice gives the same order', () => {
  const pages = fixture({
    'index.hyx': '',
    'a.hyx': '',
    'b/[x].hyx': '',
    'b/c.hyx': '',
    'b/[...r].hyx': '',
  });
  const first = scanRoutes(pages).routes.map((r) => r.pattern);
  const second = scanRoutes(pages).routes.map((r) => r.pattern);
  assert.deepEqual(first, second);
  // And the order is by specificity, so resolution needs no second pass.
  assert.deepEqual(first, ['/', '/a', '/b/c', '/b/:x', '/b/*']);

  // The order is a property of resolution, not of the fixture: each of these
  // URLs still finds the route that pins the most of it.
  const { routes } = scanRoutes(pages);
  assert.equal(matchRoute('/', routes).route.pattern, '/');
  assert.equal(matchRoute('/b/c', routes).route.pattern, '/b/c');
  assert.equal(matchRoute('/b/zzz', routes).route.pattern, '/b/:x');
  assert.equal(matchRoute('/b/zzz/deeper', routes).route.pattern, '/b/*');
});

test('a .server file beside a page is adopted by it', () => {
  const pages = fixture({
    'blog/[slug].hyx': '',
    'blog/[slug].server.hys': '',
    'about.hyx': '',
  });
  const table = scanRoutes(pages);
  const post = table.routes.find((r) => r.pattern === '/blog/:slug');
  assert.equal(post.serverFile, 'blog/[slug].server.hys');
  // A page with no server half has none, and that is not an error.
  const about = table.routes.find((r) => r.pattern === '/about');
  assert.equal(about.serverFile, null);
  assert.deepEqual(table.errors_diagnostics, []);
});

test('a .server file is never itself a route', () => {
  const pages = fixture({ 'index.hyx': '', 'index.server.hys': '' });
  const table = scanRoutes(pages);
  assert.deepEqual(table.routes.map((r) => r.pattern), ['/']);
});

test('an orphan .server file is reported, naming the page it expected', () => {
  const pages = fixture({ 'index.hyx': '', 'typo.server.hys': '' });
  const table = scanRoutes(pages);
  assert.equal(table.errors_diagnostics.length, 1);
  const msg = table.errors_diagnostics[0];
  assert.match(msg, /typo\.server\.hys/);
  assert.match(msg, /typo\.hys/);
});

test('the generated module carries serverFile per route', () => {
  const pages = fixture({ 'blog/[slug].hyx': '', 'blog/[slug].server.hys': '' });
  const table = scanRoutes(pages);
  const src = routesModuleSource(table, {});
  // JSON.stringify does not escape `/`, so the emitted text has it literally.
  assert.ok(src.includes('"serverFile":"blog/[slug].server.hys"'), src.slice(0, 400));
  assert.ok(src.includes("serverFile"), 'serverFile must travel with the route');
});
