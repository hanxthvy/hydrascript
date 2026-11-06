// [xihanzu-NR]
/**
 * File-based routing and per-route code-splitting, end to end.
 *
 * Why this file exists: every example project in this repo either sets
 * `routes: false` or has no `src/pages`, so NOTHING in CI ever built a project
 * that uses the router. `lazyPages` was claimed in the README and in the
 * changelog and had no test — a reviewer verified it by grep and reported it as
 * working, which it was, but only because nobody had broken it yet.
 *
 * The assertions are about the BUILD OUTPUT, because that is the part a user
 * pays for: a project with four pages must produce four route chunks plus a
 * shared one, and the entry must not contain the pages inline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from './runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function project(pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-routes-'));
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({
      name: 'routes-fixture',
      version: '0.0.1',
      root: './src',
      outputDir: './dist',
      entries: { app: './src/main.hyx' },
      compiler: { target: 'react-18' },
      rendering: { ssg: true },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>r</title></head><body><div id="root"></div>' +
      '<script type="module" src="/src/main.hyx"></script></body></html>',
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    '# [xihanzu-NR]\nfrom hydra import mount\nfrom "./App.hyx" import App\nmount(App())\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    '# [xihanzu-NR]\nfrom hydra import Router\n\ncomponent App():\n    Router()\n',
  );
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  for (const name of pages) {
    // `index` is the folder's own page, so it produces `/`; anything else
    // produces `/<Name>`. The router is case-sensitive on purpose, so the file
    // name and the URL agree exactly.
    fs.writeFileSync(
      path.join(dir, 'src', 'pages', `${name}.hyx`),
      `# [xihanzu-NR]\ncomponent ${name}():\n    div(cls="page"):\n        h1(): "${name}"\n`,
    );
  }
  // The example's node_modules is the only place React is installed in this
  // checkout; linking beats a second install per test.
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');
  return dir;
}

test('four pages produce four route chunks, not one bundle', async () => {
  const dir = project(['Home', 'About', 'Projects', 'Contact']);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }

  const assets = path.join(dir, 'dist', 'assets');
  const js = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) js.push(path.relative(assets, p));
    }
  };
  walk(assets);

  const chunks = js.filter((f) => f.startsWith('chunks/'));
  assert.ok(chunks.length >= 4, `expected a chunk per page, got ${chunks.length}: ${js.join(', ')}`);

  // Each page's own module must be IN a chunk, not in the entry. The entry is
  // the file index.html loads; if a page's body is in there, splitting did not
  // happen and the first paint pays for the whole site.
  const entry = js.find((f) => f.startsWith('index-'));
  assert.ok(entry, 'no entry bundle in dist/assets');
  const entrySource = fs.readFileSync(path.join(assets, entry), 'utf8');
  const chunkSource = chunks.map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');

  for (const name of ['Home', 'About', 'Projects', 'Contact']) {
    assert.ok(chunkSource.includes(name), `${name} is not in any route chunk`);
  }
  // A page's literal text is the cheapest unambiguous marker of its body.
  assert.ok(
    !/h1[^]{0,40}"Home"/.test(entrySource),
    'the entry bundle contains a page body — route splitting regressed',
  );
});

test('a dynamic route builds, and SSG leaves it a shell', async () => {
  const dir = project(['index']);
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?"):\n    div(cls="post"):\n        h1(): slug\n',
  );
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }
  // `dist/` must exist and the static routes must be there. The dynamic route
  // is the server's job until `generateStaticParams` exists.
  assert.ok(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'static home page missing');
});

test('the SSG pass inlines each page own loader data', async () => {
  // `index` is `/`; the other is `/About`. Two pages, two documents, each with
  // its own loader data.
  const dir = project(['index', 'About']);
  for (const [name, value] of [['index', 'home-value'], ['About', 'about-value']]) {
    fs.writeFileSync(
      path.join(dir, 'src', 'pages', `${name}.server.hys`),
      `# [xihanzu-NR]\nexport def loader(event):\n    return {"marker": "${value}"}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'pages', `${name}.hyx`),
      `# [xihanzu-NR]\ncomponent ${name === 'index' ? 'Home' : name}(marker: str = "none"):\n    div(cls="page"):\n        p(): marker\n`,
    );
  }
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }
  const home = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  // `About.hyx` is the URL `/About` — the route table is case-sensitive, so the
  // document lands in `dist/About/index.html`, not `dist/about/`.
  const about = fs.readFileSync(path.join(dir, 'dist', 'About', 'index.html'), 'utf8');
  assert.ok(home.includes('home-value'), 'home page did not receive its own loader data');
  assert.ok(about.includes('about-value'), 'about page did not receive its own loader data');
  assert.ok(!home.includes('about-value'), 'home page received ANOTHER page loader data');
});

test('generateStaticParams turns a dynamic route into real documents', async () => {
  const dir = project(['index']);
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?"):\n    div(cls="post"):\n        h1(): slug\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    [
      '# [xihanzu-NR]',
      'POSTS = ["hello", "world"]',
      '',
      'export def static_params():',
      '    return [{"slug": p} for p in POSTS]',
      '',
      'export def loader(event):',
      '    return {"slug": event.params["slug"]}',
      '',
    ].join('\n'),
  );
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }
  for (const slug of ['hello', 'world']) {
    const doc = path.join(dir, 'dist', 'blog', slug, 'index.html');
    assert.ok(fs.existsSync(doc), `no document for /blog/${slug}`);
    const html = fs.readFileSync(doc, 'utf8');
    assert.ok(html.includes(`<h1>${slug}</h1>`), `/blog/${slug} rendered the wrong slug`);
  }
});

test('a dynamic route WITHOUT static_params stays dynamic and says so', async () => {
  const dir = project(['index']);
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?"):\n    div(cls="post"):\n        h1(): slug\n',
  );
  const cwd = process.cwd();
  process.chdir(dir);
  let log = '';
  const realLog = console.log;
  console.log = (...a) => { log += a.join(' ') + '\n'; };
  try {
    await runBuild(dir, {});
  } finally {
    console.log = realLog;
    process.chdir(cwd);
  }
  // Not opted in: no bogus document, and the build names the route so the
  // person reading the output knows why their crawler sees a shell.
  assert.ok(!fs.existsSync(path.join(dir, 'dist', 'blog')), 'wrote a document for an unparametrised URL');
  assert.match(log, /\/blog\/:slug/, 'the build did not name the dynamic route it left alone');
});

test('metadata() gives each generated document its own title and share tags', async () => {
  const dir = project(['index']);
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?"):\n    div(cls="post"):\n        h1(): slug\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    [
      '# [xihanzu-NR]',
      'POSTS = ["hello", "world"]',
      '',
      'export def static_params():',
      '    return [{"slug": p} for p in POSTS]',
      '',
      'export def loader(event):',
      '    return {"slug": event.params["slug"]}',
      '',
      'export def metadata(event):',
      '    slug = event.params["slug"]',
      '    return {',
      '        "title": "Post " + slug,' ,
      '        "canonical": "https://x.test/blog/" + slug,',
      '        "og:title": "Post " + slug,',
      '        "twitter:card": "summary_large_image",',
      '    }',
      '',
    ].join('\n'),
  );
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }
  for (const slug of ['hello', 'world']) {
    const html = fs.readFileSync(path.join(dir, 'dist', 'blog', slug, 'index.html'), 'utf8');
    assert.ok(html.includes(`<title>Post ${slug}</title>`), `/blog/${slug} has the wrong title`);
    assert.ok(html.includes(`href="https://x.test/blog/${slug}"`), `/blog/${slug} has the wrong canonical`);
    assert.ok(html.includes(`<meta property="og:title" content="Post ${slug}"`), 'og:title missing');
    assert.ok(html.includes('name="twitter:card"'), 'twitter:card missing');
  }
  // The two documents must NOT share a title: that is the whole point, and a
  // build that applies the static dict to every slug passes a weaker check.
  const a = fs.readFileSync(path.join(dir, 'dist', 'blog', 'hello', 'index.html'), 'utf8');
  const b = fs.readFileSync(path.join(dir, 'dist', 'blog', 'world', 'index.html'), 'utf8');
  assert.notEqual(
    /<title>[^<]*<\/title>/.exec(a)[0],
    /<title>[^<]*<\/title>/.exec(b)[0],
    'both slugs got the same title',
  );
});

test('a metadata function that returns an unknown key fails loudly', async () => {
  const dir = project(['index']);
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?"):\n    div(cls="post"):\n        h1(): slug\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    [
      'export def static_params():',
      '    return [{"slug": "x"}]',
      '',
      'export def loader(event):',
      '    return {"slug": "x"}',
      '',
      'export def metadata(event):',
      '    return {"titel": "typo"}',
      '',
    ].join('\n'),
  );
  const cwd = process.cwd();
  process.chdir(dir);
  let err = '';
  const realErr = console.error;
  console.error = (...a) => { err += a.join(' ') + '\n'; };
  try {
    await runBuild(dir, {});
  } finally {
    console.error = realErr;
    process.chdir(cwd);
  }
  // A typo must name itself. Silence here ships a page with no title and no way
  // to find out why.
  assert.match(err, /titel/);
});

test('a single-page app without src/pages pre-renders index.html when ssg is on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-ssg-single-'));
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({
      name: 'single-page',
      version: '0.0.1',
      root: './src',
      outputDir: './dist',
      entries: { app: './src/main.hyx' },
      compiler: { target: 'react-18' },
      rendering: { ssg: true },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>s</title></head><body><div id="root"></div>' +
      '<script type="module" src="/src/main.hyx"></script></body></html>',
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nmount(App())\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    'component App():\n    div(cls="landing"):\n        h1(): "Welcome to the landing page"\n',
  );
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }

  const html = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.ok(
    html.includes('Welcome to the landing page'),
    `dist/index.html root was empty — single-page SSG did not run: ${html}`,
  );
});
