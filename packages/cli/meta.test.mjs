// [xihanzu-NR]
/**
 * `meta` — a page's title and description, in the static HTML and after a
 * client navigation.
 *
 * These assertions are on the BYTES the build wrote, not on the table it wrote
 * them from, because "the table has the value" and "the page has the title" are
 * different claims and only one of them is the feature. The `meta` name was
 * dead once already: a page could declare it, the build was green, and
 * `dist/about/index.html` still said `<title>app</title>`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from './runner.mjs';
import { scanRoutes } from './router.mjs';
import { readMeta, applyMeta } from './meta.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

const SHELL =
  '<!DOCTYPE html><html><head>' +
  '<title>shell title</title>' +
  '<meta name="description" content="shell description" />' +
  '</head><body><div id="root"></div></body></html>';

/** A two-page project: one page with `meta`, one without. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-meta-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'meta', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    '# [xihanzu-NR]\nfrom hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    '# [xihanzu-NR]\nfrom hydra import Router\ncomponent App():\n    Router()\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.hyx'),
    '# [xihanzu-NR]\ncomponent Home():\n    div(cls="home"): "home"\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

function writePage(dir, rel, source) {
  const file = path.join(dir, 'src', 'pages', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

test('a page with meta builds HTML with its own title and description', async () => {
  const dir = project();
  try {
    writePage(
      dir,
      'about.hyx',
      '# [xihanzu-NR]\nmeta = {"title": "About — Meta", "description": "The about page."}\n\n' +
        'component About():\n    div(cls="about"): "about"\n',
    );
    await runBuild(dir, { dev: false, mode: 'production' });

    const html = fs.readFileSync(path.join(dir, 'dist', 'about', 'index.html'), 'utf8');
    assert.match(html, /<title>About — Meta<\/title>/);
    assert.match(html, /<meta name="description" content="The about page\." \/>/);
    // The shell's own values are REPLACED, not appended: two <title> elements
    // in one document is a page whose tab text depends on the browser.
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.doesNotMatch(html, /shell title/);
    assert.doesNotMatch(html, /shell description/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a page with no meta keeps the shell title', async () => {
  const dir = project();
  try {
    writePage(
      dir,
      'plain.hyx',
      '# [xihanzu-NR]\ncomponent Plain():\n    div(cls="plain"): "plain"\n',
    );
    await runBuild(dir, { dev: false, mode: 'production' });

    for (const rel of ['index.html', path.join('plain', 'index.html')]) {
      const html = fs.readFileSync(path.join(dir, 'dist', rel), 'utf8');
      assert.match(html, /<title>shell title<\/title>/, `${rel} must keep the shell's title`);
      assert.match(html, /content="shell description"/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('& and < in meta are escaped, so neither ends the tag early', () => {
  // The unit shape of the same guarantee, because a title is TEXT and the
  // build's job is to keep it text. `</title>` in a title would otherwise
  // close the element and put the rest of the string into the document.
  const html = applyMeta(SHELL, {
    title: 'Docs & <Guides>',
    description: 'A & B </title><script>alert(1)</script>',
  });
  assert.match(html, /<title>Docs &amp; &lt;Guides&gt;<\/title>/);
  assert.match(html, /content="A &amp; B &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.doesNotMatch(html, /<script>alert/);
});

test('the same escaping happens in the built file, not only in the helper', async () => {
  const dir = project();
  try {
    writePage(
      dir,
      'about.hyx',
      '# [xihanzu-NR]\nmeta = {"title": "Docs & <Guides>", "description": "A & B"}\n\n' +
        'component About():\n    div(): "about"\n',
    );
    await runBuild(dir, { dev: false, mode: 'production' });
    const html = fs.readFileSync(path.join(dir, 'dist', 'about', 'index.html'), 'utf8');
    assert.match(html, /<title>Docs &amp; &lt;Guides&gt;<\/title>/);
    // Parsed as text, the title is the string the author wrote.
    assert.match(html, /content="A &amp; B"/);
    assert.doesNotMatch(html, /<title>Docs & <Guides>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meta is read from module level only, and only the two keys', () => {
  // Imported by neither: a page's `meta` is a value about the page, so a
  // component-local variable that happens to be called `meta` is not it.
  const local = readMeta('component P():\n    meta = {"title": "inner"}\n    div(): "x"\n');
  assert.equal(local.meta, null);
  assert.equal(local.error, null);

  const none = readMeta('component P():\n    div(): "x"\n');
  assert.equal(none.meta, null);

  // Python dict spelling, because that is what this language looks like.
  const py = readMeta("meta = {'title': 'A', 'description': \"B\",}\n");
  assert.deepEqual(py.meta, { title: 'A', description: 'B' });

  // A third key is an error naming it rather than a value that never reaches
  // the page — the whole reason this feature has a fixed shape.
  const extra = readMeta('meta = {"title": "A", "image": "/x.png"}\n');
  assert.match(extra.error, /"image"/);

  // A brace inside a string is text, not structure.
  const braced = readMeta('meta = {"title": "a } b"}\n');
  assert.deepEqual(braced.meta, { title: 'a } b' });
});

test('a malformed meta is a build error that names the file', async () => {
  const dir = project();
  try {
    writePage(
      dir,
      'broken.hyx',
      '# [xihanzu-NR]\nmeta = {"title": 42}\n\ncomponent Broken():\n    div(): "x"\n',
    );
    const table = scanRoutes(path.join(dir, 'src', 'pages'));
    assert.equal(table.errors_diagnostics.length, 1, JSON.stringify(table.errors_diagnostics));
    assert.match(table.errors_diagnostics[0], /broken\.hyx/);
    assert.match(table.errors_diagnostics[0], /quotes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
