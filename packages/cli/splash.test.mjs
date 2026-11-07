// [xihanzu-NR]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOptions,
  injectSplash,
  hasGeneratedSplash,
  splashCss,
  bootScript,
} from './splash.mjs';

const SHELL = '<html><head><title>x</title></head><body><div id="root"></div></body></html>';

test('splash: no config means no splash', () => {
  assert.equal(resolveOptions(undefined), null);
  assert.equal(resolveOptions(null), null);
  assert.equal(resolveOptions(false), null);
});

test('splash: a plain path string is accepted', () => {
  const o = resolveOptions('./src/Splash.hyx');
  assert.equal(o.src, './src/Splash.hyx');
  assert.equal(o.color, '#cc785c');
  assert.equal(o.fallbackMs, 5000);
});

test('splash: object form overrides colour and ceiling', () => {
  const o = resolveOptions({ src: './s.hyx', color: '#123456', fallbackMs: 8000 });
  assert.equal(o.color, '#123456');
  assert.equal(o.fallbackMs, 8000);
});

test('splash: a bad colour is a build error, not a silent default', () => {
  // A splash that quietly renders in the wrong colour is harder to notice than a
  // build that stops and names the key.
  assert.throws(() => resolveOptions({ src: './s.hyx', color: 'purple' }), /hex colour/);
});

test('splash: a missing src is named', () => {
  assert.throws(() => resolveOptions({}), /src is required/);
});

test('splash: the removed panel count is rejected, not ignored', () => {
  assert.throws(() => resolveOptions({ src: './s.hyx', count: 5 }), /count is no longer used/);
});

test('splash: shell goes before the app root so it paints first', () => {
  const html = injectSplash(SHELL, resolveOptions('./s.hyx'));
  assert.ok(html.indexOf('boot-splash') < html.indexOf('id="root"'));
});

test('splash: injection is idempotent', () => {
  const o = resolveOptions('./s.hyx');
  const once = injectSplash(SHELL, o);
  const twice = injectSplash(once, o);
  assert.equal(twice, once);
  assert.equal((twice.match(/id="boot-splash"/g) || []).length, 1);
});

test('splash: the wrapper is transparent, only the mount is coloured', () => {
  // The most common hand-written bug: a coloured wrapper makes panels look like
  // they never leave, because sliding away reveals the same colour.
  const css = splashCss(resolveOptions('./s.hyx'));
  const shell = /#boot-splash \{([^}]*)\}/.exec(css);
  assert.ok(shell, 'shell rule present');
  assert.match(shell[1], /background:\s*transparent/);
});

test('splash: no CSS animation on the shell element', () => {
  // An animation outranks a plain transform, so the release declaration never
  // applies and the splash waits for the animation instead.
  const css = splashCss(resolveOptions('./s.hyx'));
  const shell = /#boot-splash \{([^}]*)\}/.exec(css)[1];
  assert.ok(!/animation/.test(shell));
});

test('splash: the release moves by more than 100% to cover subpixel edges', () => {
  const css = splashCss(resolveOptions('./s.hyx'));
  assert.match(css, /translateY\(-102%\)/);
});

test('splash: a CSS-only fail-safe exists for when JS never runs', () => {
  const css = splashCss(resolveOptions('./s.hyx'));
  assert.match(css, /#boot-bail:active ~ #boot-splash/);
});

test('splash: the ceiling is inlined so a stuck asset cannot hold the page', () => {
  const boot = bootScript(resolveOptions({ src: './s.hyx', fallbackMs: 4321 }));
  assert.match(boot, /setTimeout\(release, 4321\)/);
});

test('splash: the api object is created once, so done() reaches the real element', () => {
  // Assigning a fresh object in the entry silently replaces the one holding the
  // release closure, and the splash then only leaves on the ceiling.
  const boot = bootScript(resolveOptions('./s.hyx'));
  assert.equal((boot.match(/window\.hydra\.splash = \{/g) || []).length, 0);
  assert.match(boot, /api\.release = release/);
});

test('splash: marker reports what was generated', () => {
  const html = injectSplash(SHELL, resolveOptions('./s.hyx'));
  assert.equal(hasGeneratedSplash(html), true);
  assert.equal(hasGeneratedSplash(SHELL), false);
});
