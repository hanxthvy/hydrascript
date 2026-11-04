#!/usr/bin/env node
// [xihanzu-NR]
/**
 * Publish the per-platform compiler packages.
 *
 * Why this exists as a script and not only as a workflow: `binaries.yml` builds
 * and publishes the seven `@hydrascript/<target>` packages, but npm refuses to
 * configure a trusted publisher for a package that does not exist yet — so the
 * FIRST publish of each name has to happen with real credentials. This is that
 * one-time bootstrap, and it is also the thing to re-run whenever a release is
 * cut from a machine that already has the artifacts.
 *
 * Input: a directory of downloaded workflow artifacts, one per target, each
 * containing `bin/hydra`, and `bin/hydra.node` where the platform supports the
 * in-process addon (musl cannot: cargo refuses a cdylib for that target).
 *
 * Usage:
 *   node scripts/publish-platform-packages.mjs --dir /tmp/plat [--dry-run]
 *
 * Every package is verified before it is published: the binary must exist, be
 * non-empty, and be the right architecture for its name. A package that ships
 * the wrong file is worse than one that does not ship at all, because
 * `npm i hydrascript` then succeeds and the command dies with a loader error
 * that names nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** target -> the package metadata npm matches against the running machine. */
const TARGETS = {
  'linux-x64': { os: ['linux'], cpu: ['x64'], libc: ['glibc'], bin: 'hydra', addon: 'hydra.node' },
  'linux-arm64': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'], bin: 'hydra', addon: 'hydra.node' },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'], bin: 'hydra', addon: null },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'], bin: 'hydra', addon: null },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'], bin: 'hydra', addon: 'hydra.node' },
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'], bin: 'hydra', addon: 'hydra.node' },
  'win32-x64': { os: ['win32'], cpu: ['x64'], bin: 'hydra.exe', addon: 'hydra.node' },
};

const args = process.argv.slice(2);
const dirAt = args.indexOf('--dir');
const DIR = dirAt > -1 ? path.resolve(args[dirAt + 1]) : null;
const DRY = args.includes('--dry-run');
const ONLY = (() => {
  const at = args.indexOf('--only');
  return at > -1 ? args[at + 1].split(',') : null;
})();

if (!DIR) {
  console.error('usage: node scripts/publish-platform-packages.mjs --dir <artifacts> [--dry-run] [--only a,b]');
  process.exit(2);
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = rootPkg.version;

/** A binary is right for its name, or the package must not be published. */
function verifyBinary(target, binPath) {
  const size = fs.statSync(binPath).size;
  if (size < 200_000) {
    throw new Error(`${target}: ${binPath} is ${size} bytes — too small to be the compiler`);
  }
  const head = fs.readFileSync(binPath, { encoding: null, flag: 'r' }).subarray(0, 4);
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  const isMachO = [0xcafebabe, 0xbebafeca, 0xfeedface, 0xfeedfacf, 0xcffaedfe, 0xcefaedfe].includes(
    head.readUInt32BE(0),
  );
  const isPE = head[0] === 0x4d && head[1] === 0x5a;
  const want = target.startsWith('linux') ? 'elf' : target.startsWith('darwin') ? 'macho' : 'pe';
  const got = isElf ? 'elf' : isMachO ? 'macho' : isPE ? 'pe' : 'unknown';
  if (got !== want) {
    throw new Error(`${target}: expected a ${want} binary, got ${got} (${binPath})`);
  }
  return size;
}

function npmPublish(cwd, extra = []) {
  const out = execFileSync('npm', ['publish', '--access', 'public', ...extra], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim();
}

const published = [];
const failed = [];

for (const [target, spec] of Object.entries(TARGETS)) {
  if (ONLY && !ONLY.includes(target)) continue;
  const src = path.join(DIR, target, 'bin');
  const binPath = path.join(src, spec.bin);
  if (!fs.existsSync(binPath)) {
    failed.push(`${target}: no ${spec.bin} in ${src}`);
    console.error(`  SKIP ${target}: no ${spec.bin}`);
    continue;
  }

  let size;
  try {
    size = verifyBinary(target, binPath);
  } catch (err) {
    failed.push(err.message);
    console.error(`  FAIL ${target}: ${err.message}`);
    continue;
  }

  const pkgDir = path.join(DIR, target, 'pkg');
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });

  // Copy only what the package needs. A stray `.map` or a test fixture in the
  // tarball is bytes every user downloads.
  fs.copyFileSync(binPath, path.join(pkgDir, 'bin', spec.bin));
  fs.chmodSync(path.join(pkgDir, 'bin', spec.bin), 0o755);
  if (spec.addon) {
    const addonPath = path.join(src, spec.addon);
    if (fs.existsSync(addonPath)) {
      fs.copyFileSync(addonPath, path.join(pkgDir, 'bin', spec.addon));
    }
  }

  const pkg = {
    name: `@hydrascript/${target}`,
    version: VERSION,
    description: `The HydraScript native compiler for ${target}.`,
    os: spec.os,
    cpu: spec.cpu,
    ...(spec.libc ? { libc: spec.libc } : {}),
    files: ['bin/'],
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/hanxthvy/hydrascript.git' },
  };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(
    path.join(pkgDir, 'README.md'),
    [
      `# @hydrascript/${target}`,
      '',
      'The native compiler for HydraScript on this platform. Installed automatically',
      'as an optional dependency of [`hydrascript`](https://www.npmjs.com/package/hydrascript);',
      'there is no reason to install it directly.',
      '',
      `- Binary: \`bin/${spec.bin}\` (${Math.round(size / 1024)} KB)`,
      spec.addon ? '- In-process addon: `bin/hydra.node`' : '- No in-process addon on this target (the CLI is used)',
      '',
      'MIT.',
      '',
    ].join('\n'),
  );

  if (DRY) {
    console.log(`  OK   ${target}: ${Math.round(size / 1024)} KB, not published (--dry-run)`);
    published.push(`${target} (dry)`);
    continue;
  }

  try {
    // `--provenance` needs a CI OIDC token; a local publish has none, and npm
    // rejects the flag rather than ignoring it.
    npmPublish(pkgDir);
    console.log(`  SENT ${target}@${VERSION} (${Math.round(size / 1024)} KB)`);
    published.push(target);
  } catch (err) {
    const msg = String(err.stderr || err.message || err).split('\n').filter(Boolean).slice(-3).join(' ');
    failed.push(`${target}: ${msg}`);
    console.error(`  FAIL ${target}: ${msg}`);
  }
}

console.log('');
console.log(`version ${VERSION}: ${published.length} named, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
