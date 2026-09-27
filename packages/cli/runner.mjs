// [xihanzu-NR]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const selfRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolvePkg(name, cwd) {
  const bases = [
    HERE,
    path.join(HERE, '../..'),
    '/root/projects/hydra',
    cwd,
  ];
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      return req.resolve(name);
    } catch {}
  }
  try {
    return selfRequire.resolve(name);
  } catch {
    throw new Error(`Cannot resolve package '${name}'`);
  }
}

async function loadBundlerDeps(cwd) {
  const esbuildPath = resolvePkg('esbuild', cwd);
  const postcssPath = resolvePkg('postcss', cwd);
  const twPath = resolvePkg('tailwindcss', cwd);
  const apPath = resolvePkg('autoprefixer', cwd);

  const esbuild = await import(esbuildPath);
  const postcssMod = await import(postcssPath);
  const postcss = postcssMod.default || postcssMod;
  const twMod = await import(twPath);
  const tailwindcss = twMod.default || twMod;
  const apMod = await import(apPath);
  const autoprefixer = apMod.default || apMod;

  return { esbuild, postcss, tailwindcss, autoprefixer };
}

function findNativeAddon() {
  const candidates = [
    process.env.HYDRA_NATIVE,
    '/root/projects/hydra/bin/hydra.node',
    '/root/projects/hydra/bin/serpent.node',
    path.join(HERE, '../../bin/hydra.node'),
    path.join(HERE, '../../bin/serpent.node'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return selfRequire(c);
      } catch {}
    }
  }
  return null;
}

function cliFallbackCompile(file, source) {
  const candidates = [
    process.env.HYDRA_COMPILER,
    process.env.SERPENT_COMPILER,
    '/root/projects/hydra/bin/hydra',
    '/root/projects/hydra/bin/serpent',
    path.join(HERE, '../../bin/hydra'),
    path.join(HERE, '../../bin/serpent'),
  ].filter(Boolean);

  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      try {
        const out = execFileSync(bin, ['--json', '--stdin', file], {
          input: source,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        return JSON.parse(out);
      } catch (e) {
        const msg = (e.stderr || e.message || '').toString().trim();
        return { error: msg || `hydra: compile failed for ${file}` };
      }
    }
  }
  return { error: 'Hydra compiler (native or CLI) not found' };
}

function createHydraEsbuildPlugin() {
  const native = findNativeAddon();
  const cache = new Map();

  function compile(file, source) {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;

    let res;
    if (native) {
      res = native.compile(source, file);
    } else {
      res = cliFallbackCompile(file, source);
    }
    cache.set(file, res);
    return res;
  }

  return {
    name: 'hydra-compiler-plugin',
    setup(build) {
      build.onLoad({ filter: /\.(hyx|hsx)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        return { contents: res.code, loader: 'tsx', resolveDir: path.dirname(args.path) };
      });

      build.onLoad({ filter: /\.(hys|hs)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        return { contents: res.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function readConfig(cwd) {
  const configPath = path.join(cwd, 'hydraconfig.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('[hydra] Error parsing hydraconfig.json:', e.message);
    }
  }
  return config;
}

export async function runBuild(cwd = process.cwd()) {
  const t0 = Date.now();
  console.log('[hydra] Building for production (Hydra native bundler)...');

  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const assetsDir = path.join(outDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const { esbuild, postcss, tailwindcss, autoprefixer } = await loadBundlerDeps(cwd);

  // 1. Discover entrypoint
  const entryCandidates = [
    path.join(cwd, 'src/main.hyx'),
    path.join(cwd, 'src/main.hsx'),
    path.join(cwd, 'src/index.hyx'),
    path.join(cwd, 'src/index.hsx'),
  ];
  const entryPoint = entryCandidates.find((f) => fs.existsSync(f));
  if (!entryPoint) {
    throw new Error('[hydra] Entrypoint not found: expected src/main.hyx');
  }

  // 2. Discover hydra runtime alias
  const hydraAlias = [
    path.resolve(cwd, 'src/hydra.hys'),
    path.resolve(cwd, 'src/hydra.hs'),
    '/root/projects/hydra/runtime-js/serpent-js.js',
  ].find((f) => fs.existsSync(f)) || path.resolve(cwd, 'src/hydra.hys');

  // 3. Bundle JavaScript via esbuild
  const jsOutFile = path.join(assetsDir, 'index.js');
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    sourcemap: true,
    jsx: 'automatic',
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: jsOutFile,
    plugins: [createHydraEsbuildPlugin()],
    resolveExtensions: ['.hyx', '.hys', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    alias: {
      hydra: hydraAlias,
      '@': path.resolve(cwd, 'src'),
    },
    loader: {
      '.css': 'empty',
    },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  // 4. Compile CSS via PostCSS with Tailwind
  const cssInPath = path.join(cwd, 'src/index.css');
  const cssOutPath = path.join(assetsDir, 'index.css');
  if (fs.existsSync(cssInPath)) {
    const rawCss = fs.readFileSync(cssInPath, 'utf8');
    const userTailwind = config.tailwind || {};
    const twConfig = {
      ...userTailwind,
      content: Array.from(new Set([
        path.join(cwd, 'index.html'),
        path.join(cwd, 'src/**/*.{hyx,hys,hsx,hs,html,css}'),
        ...(userTailwind.content || []),
      ])),
      theme: userTailwind.theme || { extend: {} },
      plugins: userTailwind.plugins || [],
    };

    const cssResult = await postcss([tailwindcss(twConfig), autoprefixer()]).process(rawCss, {
      from: cssInPath,
      to: cssOutPath,
    });
    fs.writeFileSync(cssOutPath, cssResult.css, 'utf8');
  }

  // 5. Generate dist/index.html
  const htmlInPath = path.join(cwd, 'index.html');
  const htmlOutPath = path.join(outDir, 'index.html');
  if (fs.existsSync(htmlInPath)) {
    let html = fs.readFileSync(htmlInPath, 'utf8');
    // Replace source entry with built bundle
    html = html.replace(/<script[^>]*src=["']\/src\/main\.(hyx|hsx|tsx|ts|js)["'][^>]*><\/script>/i, '<script type="module" crossorigin src="/assets/index.js"></script>');
    if (!html.includes('/assets/index.css')) {
      html = html.replace('</head>', '  <link rel="stylesheet" crossorigin href="/assets/index.css">\n  </head>');
    }
    fs.writeFileSync(htmlOutPath, html, 'utf8');
  }

  // 6. Copy public/ directory
  const publicDir = path.join(cwd, 'public');
  if (fs.existsSync(publicDir)) {
    copyDirRecursive(publicDir, outDir);
  }

  const ms = Date.now() - t0;
  console.log(`[hydra] Built successfully in ${ms}ms -> ${path.relative(cwd, outDir)}/`);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function serveDirectory(dir, port = 5173, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';

    let filePath = path.join(dir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(dir, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(port, host, () => {
    console.log(`[hydra] Server running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  });
}

export async function runPreview(cwd = process.cwd()) {
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = config.server?.port || 5173;
  const host = config.server?.host || '0.0.0.0';

  if (!fs.existsSync(outDir)) {
    console.log('[hydra] Output directory not found. Running build first...');
    await runBuild(cwd);
  }

  console.log('[hydra] Previewing production build:');
  await serveDirectory(outDir, port, host);
}

export async function runDev(cwd = process.cwd()) {
  // Build first then serve with auto rebuild
  await runBuild(cwd);
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = config.server?.port || 5173;
  const host = config.server?.host || '0.0.0.0';

  console.log('[hydra] Development mode active.');
  await serveDirectory(outDir, port, host);

  // Watch src/ directory for changes
  const srcDir = path.join(cwd, 'src');
  if (fs.existsSync(srcDir)) {
    let building = false;
    fs.watch(srcDir, { recursive: true }, async () => {
      if (building) return;
      building = true;
      try {
        await runBuild(cwd);
      } catch (err) {
        console.error('[hydra] Build error:', err.message);
      } finally {
        building = false;
      }
    });
  }
}

// CLI entrypoint
const cmd = process.argv[2] || 'dev';
const cwd = process.cwd();

if (cmd === 'dev') {
  runDev(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === 'build') {
  runBuild(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === 'preview') {
  runPreview(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`[hydra] Unknown command: ${cmd}`);
  process.exit(1);
}
