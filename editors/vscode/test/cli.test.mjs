// [xihanzu-NR]
/**
 * The pure half of the extension: paths, scaffolds, and the exact command a
 * menu item runs.
 *
 * The interesting assertion is that every template the scaffolder writes is
 * accepted by the COMPILER, not that it looks like the string in this file. A
 * "New Page" command that emits a syntax error teaches the wrong syntax on the
 * first keystroke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { runCli, tempDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  routeForPath,
  toPascal,
  validateName,
  templateFor,
  cliCommandFor,
  resolveCompiler,
  compilerInvocation,
  supportsLanguageServer,
} = require('../src/cli.js');

test('a page’s filename is its URL', () => {
  assert.equal(routeForPath('src/pages/index.hyx'), '/');
  assert.equal(routeForPath('src/pages/about.hyx'), '/about');
  assert.equal(routeForPath('src/pages/blog/index.hyx'), '/blog');
  assert.equal(routeForPath('src/pages/blog/[slug].hyx'), '/blog/:slug');
  assert.equal(routeForPath('src/pages/files/[...path].hyx'), '/files/*');
});

test('an API route lives under /api, which is the folder and not a decoration', () => {
  assert.equal(routeForPath('src/api/hello.hys'), '/api/hello');
  assert.equal(routeForPath('src/api/users/index.hys'), '/api/users');
  assert.equal(routeForPath('src/api/users/[id].hys'), '/api/users/:id');
});

test('a server half is not a page of its own', () => {
  assert.equal(routeForPath('src/pages/about.hyx'), routeForPath('src/pages/about.server.hys'));
});

test('component names are what an import can use', () => {
  assert.equal(toPascal('user-card'), 'UserCard');
  assert.equal(toPascal('blog/[slug]'), 'BlogSlug');
  assert.equal(toPascal('2fa'), 'Page2fa');
});

test('a name that would produce an unimportable file is refused', () => {
  assert.equal(validateName('about'), null);
  assert.equal(validateName('blog/[slug]'), null);
  assert.ok(validateName(''));
  assert.ok(validateName('../escape'));
  assert.ok(validateName('/absolute'));
  assert.ok(validateName('with space'));
});

test('every scaffold the commands write is accepted by the compiler', () => {
  const dir = tempDir();
  const cases = [
    ['page', 'about'],
    ['page', 'blog/[slug]'],
    ['component', 'UserCard'],
    ['api', 'hello'],
    ['api', 'users/[id]'],
    ['loader', 'about'],
    ['middleware', ''],
  ];
  for (const [kind, name] of cases) {
    const scaffold = templateFor(kind, name);
    const absolute = path.join(dir, scaffold.relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, scaffold.content);
    const result = runCli(['check', absolute]);
    assert.equal(
      result.status,
      0,
      `${kind} ${name} -> ${scaffold.relPath} does not compile:\n${result.output}`,
    );
  }
});

test('the scaffold puts a page where the router looks for it', () => {
  assert.equal(templateFor('page', 'about').relPath, 'src/pages/about.hyx');
  assert.equal(templateFor('page', 'about').route, '/about');
  assert.equal(templateFor('component', 'Card').relPath, 'src/components/Card.hyx');
  assert.equal(templateFor('api', 'users/[id]').route, '/api/users/:id');
  assert.equal(templateFor('loader', 'about').relPath, 'src/pages/about.server.hys');
  assert.equal(templateFor('middleware', '').relPath, 'src/middleware.hys');
});

test('the loader scaffold only imports hydra/server, which is the file that may', () => {
  const content = templateFor('loader', 'about').content;
  assert.match(content, /from "hydra\/server" import env/);
  assert.match(content, /export async def loader\(event\)/);
});

test('a menu item maps to the command line the README documents', () => {
  assert.equal(cliCommandFor('hydra.dev'), 'hydra dev');
  assert.equal(cliCommandFor('hydra.build'), 'hydra build');
  assert.equal(cliCommandFor('hydra.routes'), 'hydra routes');
  assert.equal(cliCommandFor('hydra.check', { file: '/p/src/pages/index.hyx' }), 'hydra check "/p/src/pages/index.hyx"');
  assert.equal(cliCommandFor('hydra.format', { file: '/p/a.hyx' }), 'hydra fmt "/p/a.hyx"');
  assert.equal(cliCommandFor('hydra.explain', { url: '/about' }), 'hydra explain "/about"');
  assert.equal(cliCommandFor('hydra.nothing'), null);
});

test('a .js CLI is run with node, and told it is node', () => {
  const invocation = compilerInvocation('/opt/hydra/bin/hydra.js', '/usr/bin/node');
  assert.equal(invocation.command, '/usr/bin/node');
  assert.deepEqual(invocation.args, ['/opt/hydra/bin/hydra.js']);
  // The extension host's process.execPath is Electron; without this the child
  // opens a window instead of running the script.
  assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1');

  const native = compilerInvocation('/usr/local/bin/hydra');
  assert.equal(native.command, '/usr/local/bin/hydra');
  assert.deepEqual(native.args, []);
});

test('the resolver prefers the runner over the native binary', () => {
  const folders = ['/project'];
  const existing = new Set(['/project/bin/hydra', '/project/bin/hydra.js']);
  const { bin, source } = resolveCompiler({
    workspaceFolders: folders,
    exists: (p) => existing.has(p),
  });
  assert.equal(bin, '/project/bin/hydra.js');
  assert.equal(source, 'workspace');
});

test('a workspace with only the native binary is still usable, just not as a server', () => {
  const existing = new Set(['/project/node_modules/hydrascript/bin/hydra']);
  const { bin } = resolveCompiler({
    workspaceFolders: ['/project'],
    exists: (p) => existing.has(p),
  });
  assert.equal(bin, '/project/node_modules/hydrascript/bin/hydra');
  assert.equal(supportsLanguageServer(bin), false);
  assert.equal(supportsLanguageServer('/project/bin/hydra.js'), true);
  assert.equal(supportsLanguageServer('hydra'), true);
});

test('an explicit setting wins over everything', () => {
  const { bin, source } = resolveCompiler({
    setting: '/custom/hydra',
    workspaceFolders: ['/project'],
    exists: (p) => p === '/custom/hydra' || p === '/project/bin/hydra.js',
  });
  assert.equal(bin, '/custom/hydra');
  assert.equal(source, 'setting');
});
