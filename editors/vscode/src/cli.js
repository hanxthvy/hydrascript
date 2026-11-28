// [xihanzu-NR]
'use strict';

/**
 * Everything here is pure: paths in, paths and source out, no VS Code, no
 * spawning. That is what lets `test/cli.test.mjs` check the scaffolder against
 * the real compiler instead of against an idea of the syntax.
 */

const path = require('node:path');

/** The native binary name for this platform. `hydra` is also the npm bin. */
function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'hydra.exe' : 'hydra';
}

/**
 * Where the CLI is, in the order a developer would expect it to be.
 *
 * The thing that answers `hydra lsp`, `hydra dev` and `hydra routes` is the
 * NODE entry (`bin/hydra.js`), not the native compiler: the Rust binary owns
 * `check`/`fmt`/`types`/`stats`/`doctor` and the JS runner owns the rest, and
 * the JS entry forwards to the binary. So `hydra.js` is tried first in every
 * root; a root that only has the native binary still works for diagnostics,
 * which is why both are candidates rather than one being assumed.
 *
 * @returns {{ bin: string|null, source: string }}
 */
function resolveCompiler(options = {}) {
  const {
    setting = '',
    env = process.env,
    extensionPath = '',
    workspaceFolders = [],
    exists = () => false,
    platform = process.platform,
  } = options;
  const exe = binaryName(platform);

  const candidates = [];
  const add = (root, source) => {
    if (!root) return;
    candidates.push({ bin: path.join(root, 'hydra.js'), source });
    candidates.push({ bin: path.join(root, exe), source });
  };

  if (setting) candidates.push({ bin: setting, source: 'setting' });
  if (env.HYDRA_COMPILER) candidates.push({ bin: env.HYDRA_COMPILER, source: 'HYDRA_COMPILER' });
  if (extensionPath) add(path.join(extensionPath, 'bin'), 'bundled');
  for (const folder of workspaceFolders) {
    add(path.join(folder, 'node_modules', 'hydrascript', 'bin'), 'workspace dependency');
    add(path.join(folder, 'bin'), 'workspace');
    candidates.push({ bin: path.join(folder, 'node_modules', '.bin', 'hydra'), source: 'workspace dependency' });
    candidates.push({
      bin: path.join(folder, 'compiler-rs', 'target', 'release', exe),
      source: 'built from source',
    });
  }

  for (const candidate of candidates) {
    if (candidate.bin && exists(candidate.bin)) return candidate;
  }
  // Last resort: PATH. Whether it exists is the spawn's answer to give, and a
  // missing binary is reported once, in the log, instead of hiding every
  // feature behind a settings screen.
  return { bin: setting || 'hydra', source: 'PATH' };
}

/** The language server lives in the node runner, so a bare native binary cannot
 *  answer it. Saying so up front beats a spawn that fails with `cannot read
 *  lsp`. */
function supportsLanguageServer(bin) {
  return /\.(c|m)?js$/i.test(String(bin)) || !path.isAbsolute(String(bin));
}

/**
 * How to run the CLI: a `.js` entry needs node.
 *
 * `process.execPath` inside the extension host is Electron, not node, so the
 * child needs `ELECTRON_RUN_AS_NODE=1` or it opens a window instead of running
 * a script. Plain node ignores the variable, which is why the tests can use the
 * same code path.
 */
function compilerInvocation(bin, nodePath = process.execPath) {
  if (/\.(c|m)?js$/i.test(String(bin))) {
    return { command: nodePath, args: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: bin, args: [], env: {} };
}

/** `src/pages/blog/[slug].hyx` -> `/blog/:slug`, `src/api/hello.hys` ->
 *  `/api/hello`, an `index` file -> its folder. The folder is part of the URL,
 *  so an API route never answers at `/hello`. */
function routeForPath(relPath) {
  const normalised = String(relPath).replace(/\\/g, '/');
  const isApi = /(^|\/)src\/api\//.test(normalised);
  const withoutSrc = normalised.replace(/^\.?\/*src\/(pages|api)\//, '');
  const withoutExt = withoutSrc.replace(/\.(hyx|hys)$/, '').replace(/\.server$/, '');
  const segments = withoutExt.split('/').filter(Boolean);
  const head = isApi ? '/api' : '';
  if (segments.length === 0) return head || '/';

  const out = segments.map((segment) => {
    if (segment === 'index') return null;
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '*';
    if (/^\[[^\]]+\]$/.test(segment)) return `:${segment.slice(1, -1)}`;
    return segment;
  });
  const kept = out.filter((s) => s !== null);
  if (kept.length === 0) return head || '/';
  return `${head}/${kept.join('/')}`;
}

function toPascal(input) {
  const words = String(input)
    .replace(/\.(hyx|hys)$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (!name) return 'Page';
  return /^[0-9]/.test(name) ? `Page${name}` : name;
}

/** Reject what would produce a file nobody can import. */
function validateName(name) {
  const value = String(name || '').trim();
  if (!value) return 'a name is required';
  if (value.includes('..')) return 'no `..` in a path';
  if (value.startsWith('/')) return 'write it relative to src/, without a leading slash';
  if (!/^[A-Za-z0-9_.\-[\]/]+$/.test(value)) return 'letters, digits, `_ - . [ ] /` only';
  return null;
}

/**
 * The file a command creates, and its contents.
 *
 * Every template is real HydraScript that the compiler accepts: `test/cli.test.mjs`
 * runs `hydra check` over each one, because a scaffolder that emits a file with
 * a syntax error teaches the wrong syntax on the first keystroke.
 *
 * @returns {{ relPath: string, content: string, route?: string, component?: string }}
 */
function templateFor(kind, rawName = '') {
  const name = String(rawName || '').trim().replace(/^\.?\/*/, '').replace(/\.(hyx|hys)$/, '');

  if (kind === 'middleware') {
    return {
      relPath: 'src/middleware.hys',
      content: [
        '# [xihanzu-NR]',
        '# src/middleware.hys — runs before every /api request, in the API layer.',
        '#',
        '# Return None to pass the request through, or a body (or `(body, status)`)',
        '# to reply and stop it here. Static files are never routed through this.',
        '',
        'export def handle(req):',
        '    return None',
        '',
      ].join('\n'),
    };
  }

  if (kind === 'api') {
    const relPath = `src/api/${name}.hys`;
    return {
      relPath,
      route: routeForPath(relPath),
      content: [
        '# [xihanzu-NR]',
        `# ${relPath} — this file IS the route. One export per HTTP method:`,
        '#   export def get(req)          -> GET',
        '#   export def post(req, body)   -> POST/PUT/PATCH/DELETE',
        '# A dict returns JSON; `(body, status)` sets the status; a Response is',
        '# returned as-is. `req.params`, `req.query`, `req.headers` are there.',
        '',
        'export def get(req):',
        '    return {"ok": True}',
        '',
        'export def post(req, body):',
        '    return {"created": body}, 201',
        '',
      ].join('\n'),
    };
  }

  if (kind === 'loader') {
    const page = name || 'index';
    const relPath = `src/pages/${page}.server.hys`;
    const noun = String(page).split('/').pop();
    return {
      relPath,
      route: routeForPath(`src/pages/${page}.hyx`),
      content: [
        '# [xihanzu-NR]',
        `# The server half of src/pages/${page}.hyx.`,
        '#',
        '# A separate FILE, because the page is a client module: its imports end up',
        '# in the browser bundle, so only a `.server.hys` may import "hydra/server".',
        '# Whatever this returns reaches the page as PROPS — `component ' + toPascal(noun) + '(build_host: str = "")`,',
        '# never `props["build_host"]`.',
        '',
        'from "hydra/server" import env',
        '',
        '',
        'export async def loader(event):',
        '    return {',
        '        "build_host": env("HYDRA_BUILD_HOST", "this machine"),',
        '    }',
        '',
      ].join('\n'),
    };
  }

  if (kind === 'component') {
    const component = toPascal(name);
    return {
      relPath: `src/components/${component}.hyx`,
      component,
      content: [
        '# [xihanzu-NR]',
        `component ${component}(title: str = "${component}"):`,
        '    section(className="rounded-xl bg-white p-4 ring-1 ring-slate-200"):',
        '        h2(className="font-semibold text-slate-900"): title',
        '        div(className="mt-2"):',
        '            slot',
        '',
      ].join('\n'),
    };
  }

  // A page: the router renders it and passes `params`, `path` and `route`, and
  // its URL comes from the filename rather than from a route table.
  const page = name || 'index';
  const relPath = `src/pages/${page}.hyx`;
  const component = toPascal(String(page).split('/').pop());
  const route = routeForPath(relPath);
  return {
    relPath,
    route,
    component,
    content: [
      '# [xihanzu-NR]',
      `# ${relPath} — this file IS the \`${route}\` route.`,
      '#',
      '# The router passes `params`, `path` and `route`. A `.server.hys` beside this',
      '# file can add props through `loader(event)`; they arrive as props, not as a',
      '# `props` dict.',
      '',
      `component ${component}(params = {}, path: str = "${route}"):`,
      '    div(className="space-y-4"):',
      `        h1(className="text-2xl font-bold text-slate-900"): "${component}"`,
      '        p(className="text-sm text-slate-500"): f"you are on {path}"',
      '',
    ].join('\n'),
  };
}

/** The commands a menu offers, and the CLI line each one runs. Pure because the
 *  tests assert the exact command line: a typo'd flag is a bug report, not a
 *  mystery. */
function cliCommandFor(command, { file = '', url = '' } = {}) {
  switch (command) {
    case 'hydra.dev':
      return 'hydra dev';
    case 'hydra.build':
      return 'hydra build';
    case 'hydra.serve':
      return 'hydra serve';
    case 'hydra.preview':
      return 'hydra preview';
    case 'hydra.routes':
      return 'hydra routes';
    case 'hydra.doctor':
      return 'hydra doctor';
    case 'hydra.stats':
      return 'hydra stats';
    case 'hydra.list':
      return 'hydra list';
    case 'hydra.test':
      return 'hydra test';
    default:
      break;
  }
  if (command === 'hydra.check') return file ? `hydra check "${file}"` : 'hydra check';
  if (command === 'hydra.format') return file ? `hydra fmt "${file}"` : 'hydra fmt';
  if (command === 'hydra.explain') return url ? `hydra explain "${url}"` : 'hydra explain';
  return null;
}

module.exports = {
  binaryName,
  resolveCompiler,
  compilerInvocation,
  supportsLanguageServer,
  routeForPath,
  toPascal,
  validateName,
  templateFor,
  cliCommandFor,
};
