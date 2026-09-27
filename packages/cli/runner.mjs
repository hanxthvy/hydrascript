// [xihanzu-NR]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const selfRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolvePkg(name, cwd) {
  try {
    const req = createRequire(path.join(cwd, 'package.json'));
    return req.resolve(name);
  } catch {
    const fallbackBases = [
      cwd,
      '/var/www/hanz',
      '/root/projects/hydra',
      '/usr/local/lib/hermes-agent',
    ];
    for (const base of fallbackBases) {
      try {
        const req = createRequire(path.join(base, 'package.json'));
        return req.resolve(name);
      } catch {}
    }
    try {
      return selfRequire.resolve(name);
    } catch {
      throw new Error(`Cannot resolve package '${name}' from ${cwd}`);
    }
  }
}

async function loadDependencies(cwd) {
  const vitePath = resolvePkg('vite', cwd);
  const reactPath = resolvePkg('@vitejs/plugin-react', cwd);
  const twPath = resolvePkg('tailwindcss', cwd);
  const apPath = resolvePkg('autoprefixer', cwd);

  const vite = await import(vitePath);
  const reactMod = await import(reactPath);
  const react = reactMod.default || reactMod;
  const twMod = await import(twPath);
  const tailwindcss = twMod.default || twMod;
  const apMod = await import(apPath);
  const autoprefixer = apMod.default || apMod;

  return { vite, react, tailwindcss, autoprefixer };
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

export function hydrascriptPlugin(transformWithEsbuild) {
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
    name: 'vite-plugin-hydrascript',
    enforce: 'pre',

    async transform(source, id) {
      const cleanId = id.split('?')[0];

      if (cleanId.endsWith('.hsx')) {
        const res = compile(cleanId, source);
        if (res.error) {
          this.error(res.error);
          return null;
        }

        const js = await transformWithEsbuild(res.code, cleanId.replace(/\.hsx$/, '.tsx'), {
          loader: 'tsx',
          jsx: 'automatic',
          sourcemap: true,
          sourcefile: cleanId,
        });

        return { code: js.code, map: js.map };
      }

      if (cleanId.endsWith('.hs')) {
        const res = compile(cleanId, source);
        if (res.error) {
          this.error(res.error);
          return null;
        }

        const js = await transformWithEsbuild(res.code, cleanId.replace(/\.hs$/, '.js'), {
          loader: 'js',
          sourcemap: true,
          sourcefile: cleanId,
        });

        return { code: js.code, map: js.map };
      }

      return null;
    },

    handleHotUpdate(ctx) {
      if (ctx.file.endsWith('.hsx') || ctx.file.endsWith('.hs')) {
        cache.delete(ctx.file);
      }
    },
  };
}

function findConfigFile(startDir) {
  let curr = path.resolve(startDir);
  while (true) {
    const candidate = path.join(curr, 'hydraconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

export async function createViteConfig(configPath) {
  let cwd = process.cwd();
  let resolvedConfigPath = null;

  if (configPath) {
    if (fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()) {
      cwd = path.resolve(configPath);
      resolvedConfigPath = findConfigFile(cwd);
    } else {
      resolvedConfigPath = path.resolve(configPath);
      cwd = path.dirname(resolvedConfigPath);
    }
  } else {
    resolvedConfigPath = findConfigFile(cwd);
  }

  if (resolvedConfigPath && fs.existsSync(resolvedConfigPath)) {
    cwd = path.dirname(resolvedConfigPath);
  } else {
    resolvedConfigPath = path.join(cwd, 'hydraconfig.json');
  }

  let config = {};
  if (fs.existsSync(resolvedConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
    } catch (e) {
      console.error('[hydra] Error parsing hydraconfig.json:', e.message);
    }
  }

  const { vite, react, tailwindcss, autoprefixer } = await loadDependencies(cwd);

  const serverPort = config.server?.port || 5173;
  const serverHost = config.server?.host || '0.0.0.0';

  const userTailwind = config.tailwind || {};
  const twContent = Array.from(new Set([
    path.join(cwd, 'index.html'),
    path.join(cwd, 'src/**/*.{js,ts,jsx,tsx,hs,hsx}'),
    './index.html',
    './src/**/*.{hs,hsx}',
    ...(userTailwind.content || []),
  ]));

  const twConfig = {
    ...userTailwind,
    content: twContent,
    theme: userTailwind.theme || { extend: {} },
    plugins: userTailwind.plugins || [],
  };

  const plugins = [
    hydrascriptPlugin(vite.transformWithEsbuild),
    react(),
  ];

  const hydraAlias = fs.existsSync(path.resolve(cwd, 'src/hydra.hs'))
    ? path.resolve(cwd, 'src/hydra.hs')
    : (fs.existsSync('/root/projects/hydra/runtime-js/serpent-js.js')
      ? '/root/projects/hydra/runtime-js/serpent-js.js'
      : path.resolve(cwd, 'src/hydra.hs'));

  return {
    root: cwd,
    configFile: false,
    plugins,
    css: {
      postcss: {
        plugins: [
          tailwindcss(twConfig),
          autoprefixer(),
        ],
      },
    },
    resolve: {
      alias: {
        hydra: hydraAlias,
        '@': path.resolve(cwd, 'src'),
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.hsx', '.hs'],
    },
    build: {
      outDir: config.outputDir || 'dist',
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 1200,
    },
    server: {
      host: serverHost,
      port: serverPort,
    },
    preview: {
      host: serverHost,
      port: serverPort,
    },
  };
}

export async function dev(configPath) {
  let cwd = process.cwd();
  if (configPath) {
    cwd = fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()
      ? configPath
      : path.dirname(path.resolve(configPath));
  }
  const { vite } = await loadDependencies(cwd);
  const viteConfig = await createViteConfig(configPath);
  const server = await vite.createServer(viteConfig);
  await server.listen();
  server.printUrls();
  return server;
}

export async function build(configPath) {
  let cwd = process.cwd();
  if (configPath) {
    cwd = fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()
      ? configPath
      : path.dirname(path.resolve(configPath));
  }
  const { vite } = await loadDependencies(cwd);
  const viteConfig = await createViteConfig(configPath);
  return await vite.build(viteConfig);
}

export async function preview(configPath) {
  let cwd = process.cwd();
  if (configPath) {
    cwd = fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()
      ? configPath
      : path.dirname(path.resolve(configPath));
  }
  const { vite } = await loadDependencies(cwd);
  const viteConfig = await createViteConfig(configPath);
  const previewServer = await vite.preview(viteConfig);
  previewServer.printUrls();
  return previewServer;
}

export const runDev = dev;
export const runBuild = build;
export const runPreview = preview;

// CLI entrypoint when executed directly
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const cmd = process.argv[2] || 'dev';
  const hasHelp = process.argv.includes('--help') || process.argv.includes('-h');

  if (hasHelp) {
    if (cmd === 'build') {
      console.log('Usage: hydra build [configPath]\n\nBuild Hydra project for production');
    } else if (cmd === 'preview') {
      console.log('Usage: hydra preview [configPath]\n\nPreview production build');
    } else {
      console.log('Usage: hydra dev [configPath]\n\nStart Vite development server for Hydra project');
    }
    process.exit(0);
  }

  // Filter out any other flags and find configPath if provided
  const args = process.argv.slice(3);
  const configArg = args.find((a) => !a.startsWith('-'));

  if (cmd === 'dev') {
    dev(configArg).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (cmd === 'build') {
    build(configArg).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else if (cmd === 'preview') {
    preview(configArg).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    console.error(`[hydra] Unknown command: ${cmd}`);
    process.exit(1);
  }
}
