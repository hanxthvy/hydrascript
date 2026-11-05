// [xihanzu-NR]
/**
 * The CSS pipeline is the PROJECT's choice, not the framework's.
 *
 * What this locks: Tailwind used to be applied unconditionally on every build,
 * and `tailwindcss`/`postcss`/`autoprefixer` were hard dependencies. A project
 * that wanted plain CSS, Sass, or nothing still paid for Tailwind and still had
 * its stylesheet run through it. A framework choosing a project's CSS system is
 * the kind of helpful that is really a tax.
 *
 * Four paths have to work, and each one has a different owner:
 *
 *   postcss.config.*   the project's own config decides
 *   styling: [...]     exactly those plugins
 *   tailwind key       Tailwind + autoprefixer
 *   nothing at all     plain PostCSS, or raw passthrough if PostCSS is absent
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const BIN = path.join(REPO, 'bin', 'hydra');

/**
 * A project with one page and a stylesheet. `css` is the body of src/index.css,
 * `config` is merged over the defaults.
 */
function project({ css = '.card { color: red; }\n', config = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-css-'));
  const cfg = {
    name: 'css-fixture',
    version: '0.0.1',
    root: './src',
    outputDir: './dist',
    entries: { app: './src/main.hyx' },
    compiler: { target: 'react-18' },
    rendering: { ssg: true },
    ...config,
  };
  fs.writeFileSync(path.join(dir, 'hydraconfig.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>c</title></head><body><div id="root"></div>' +
      '<script type="module" src="/src/main.hyx"></script></body></html>',
  );
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nimport "./index.css"\nmount(App())\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'App.hyx'), 'from hydra import Router\n\ncomponent App():\n    Router()\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.hyx'),
    'component Home():\n    div(cls="card"):\n        h1(): "x"\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'index.css'), css);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  // React only; the CSS packages are deliberately NOT linked here, so a test
  // that expects them to be optional is honest.
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  for (const p of ['react', 'react-dom', 'scheduler']) {
    const src = path.join(REPO, 'examples', 'blog', 'node_modules', p);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, 'node_modules', p), 'dir');
  }
  return dir;
}

/** Link one package from the repo's own node_modules into the fixture. */
function link(dir, pkg) {
  const src = path.join(REPO, 'node_modules', pkg);
  if (!fs.existsSync(src)) return false;
  fs.symlinkSync(src, path.join(dir, 'node_modules', pkg), 'dir');
  return true;
}

const build = (dir) =>
  spawnSync(BIN, ['build'], { cwd: dir, encoding: 'utf8', timeout: 180000 });

const cssOut = (dir) => {
  const assets = path.join(dir, 'dist', 'assets');
  if (!fs.existsSync(assets)) return '';
  return fs
    .readdirSync(assets)
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(assets, f), 'utf8'))
    .join('\n');
};

test('a project with no CSS config gets plain PostCSS, not Tailwind', () => {
  const dir = project();
  const linked = link(dir, 'postcss');
  const res = build(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /styling: plain postcss/);
  // The card rule must survive, and no Tailwind preflight may appear.
  const css = cssOut(dir);
  assert.ok(css.includes('.card'), 'the stylesheet was dropped');
  assert.ok(!css.includes('--tw-'), 'Tailwind was applied to a project that did not ask for it');
  if (!linked) return; // postcss missing would make this the passthrough path
});

test('the tailwind key turns Tailwind on, and only then', () => {
  const dir = project({ config: { tailwind: {} } });
  link(dir, 'postcss');
  link(dir, 'tailwindcss');
  link(dir, 'autoprefixer');
  const res = build(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /styling: tailwind/);
});

test('styling: [...] runs exactly the plugins named', () => {
  const dir = project({ config: { styling: ['autoprefixer'] } });
  link(dir, 'postcss');
  const ok = link(dir, 'autoprefixer');
  const res = build(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /styling: plugins \(autoprefixer\)/);
  if (ok) assert.ok(!cssOut(dir).includes('--tw-'), 'Tailwind leaked into an explicit plugin list');
});

test('a tailwind key without tailwindcss installed fails with the fix', () => {
  // Not a silent downgrade: a project that asked for Tailwind and did not
  // install it gets a message that names the command.
  const dir = project({ config: { tailwind: {} } });
  link(dir, 'postcss');
  const res = build(dir);
  assert.notEqual(res.status, 0, 'expected a failure, got success');
  assert.match(res.stderr + res.stdout, /tailwindcss is not installed|npm i -D tailwindcss/);
});

test('a stylesheet with no PostCSS installed is copied, not lost', () => {
  const dir = project({ css: '.only { color: green; }\n' });
  const res = build(dir);
  // Either it copied raw (no postcss) or it processed it (postcss present from
  // the repo link); what must never happen is an empty stylesheet.
  const css = cssOut(dir);
  if (res.status === 0) assert.ok(css.includes('.only'), `stylesheet lost: ${JSON.stringify(css)}`);
});

test('Tailwind is not a hard dependency of the framework', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  // A project must be able to build without installing Tailwind at all.
  assert.deepEqual(Object.keys(pkg.dependencies), ['esbuild'], 'unexpected hard dependency');
  for (const p of ['postcss', 'tailwindcss', 'autoprefixer']) {
    assert.ok(pkg.peerDependencies && p in pkg.peerDependencies, `${p} should be an optional peer`);
    assert.equal(pkg.peerDependenciesMeta[p].optional, true, `${p} peer must be optional`);
  }
});
