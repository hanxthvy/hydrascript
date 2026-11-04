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
 * It publishes ONLY `@hydrascript/*`. The root `hydrascript` package is not a
 * target and cannot be reached from here: its manifest has to be wired by
 * `release.yml` after these exist, and a bootstrap that could publish it would
 * be able to ship a root pointing at packages that are not there yet.
 *
 * Input: a directory of downloaded workflow artifacts, one per target, each
 * containing `bin/hydra`, and `bin/hydra.node` where the platform supports the
 * in-process addon (musl cannot: cargo refuses a cdylib for that target).
 *
 * Usage:
 *   node scripts/publish-platform-packages.mjs --dir /tmp/plat --audit
 *   node scripts/publish-platform-packages.mjs --dir /tmp/plat --dry-run
 *   node scripts/publish-platform-packages.mjs --dir /tmp/plat
 *   node scripts/publish-platform-packages.mjs --dir /tmp/plat --only linux-x64
 *
 * Idempotent: a package already on the registry at this version is reported as
 * ALREADY and skipped. Re-running after a partial failure publishes only what is
 * missing, so a failed run costs nothing and never needs an `npm unpublish`.
 *
 * Every package is verified before it is published: the binary must exist, be
 * non-empty, be the right container for its name (ELF / Mach-O / PE) AND the
 * right CPU architecture. A package that ships the wrong file is worse than one
 * that does not ship at all, because `npm i hydrascript` then succeeds and the
 * command dies with a loader error that names nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The root package. Named here so the loop can PROVE it never targets it. */
const ROOT_PACKAGE = 'hydrascript';

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
const AUDIT = args.includes('--audit');
const ONLY = (() => {
  const at = args.indexOf('--only');
  return at > -1 ? args[at + 1].split(',') : null;
})();

if (!DIR) {
  console.error(
    'usage: node scripts/publish-platform-packages.mjs --dir <artifacts> [--audit|--dry-run] [--only a,b]',
  );
  process.exit(2);
}
if (ONLY) {
  const unknown = ONLY.filter((t) => !TARGETS[t]);
  if (unknown.length) {
    // A typo in `--only` would otherwise publish nothing and exit 0, which reads
    // as "done" when nothing happened.
    console.error(`--only names unknown target(s): ${unknown.join(', ')}`);
    console.error(`known: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
  }
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = rootPkg.version;

/**
 * The CPU a binary was built for, from its own header.
 *
 * The container check alone is not enough: an arm64 ELF is still an ELF, so a
 * build that silently produced the wrong architecture would publish under the
 * wrong name and every user on that platform would get `Exec format error`.
 */
function binaryArch(binPath, container) {
  const buf = fs.readFileSync(binPath);
  if (container === 'elf') {
    // e_machine is a 16-bit LE field at offset 18 (ELF64/ELF32 share it).
    const machine = buf.readUInt16LE(18);
    return { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'x86' }[machine] || `elf:${machine}`;
  }
  if (container === 'macho') {
    const magic = buf.readUInt32BE(0);
    // Thin binaries carry their CPU in cputype (offset 4, BE); fat binaries are
    // a container of slices and are only used by us for a single-arch build, so
    // their cputype is read from the first slice's descriptor.
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
      const first = buf.readUInt32BE(8);
      return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[first] || `fat:${first.toString(16)}`;
    }
    const cpu = buf.readUInt32LE(4);
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[cpu] || `macho:${cpu.toString(16)}`;
  }
  if (container === 'pe') {
    // COFF header follows the DOS stub; Machine is the first field of it.
    const peOff = buf.readUInt32LE(0x3c);
    const machine = buf.readUInt16LE(peOff + 4);
    return { 0x8664: 'x64', 0xaa64: 'arm64' }[machine] || `pe:${machine.toString(16)}`;
  }
  return 'unknown';
}

/** A binary is right for its name, or the package must not be published. */
function verifyBinary(target, binPath) {
  const spec = TARGETS[target];
  const size = fs.statSync(binPath).size;
  if (size < 200_000) {
    throw new Error(`${target}: ${binPath} is ${size} bytes — too small to be the compiler`);
  }
  const head = fs.readFileSync(binPath).subarray(0, 4);
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
  const arch = binaryArch(binPath, got);
  const wantArch = spec.cpu[0];
  if (arch !== wantArch) {
    // The failure this catches: a cross-build that fell back to the host target.
    // The package would install and then refuse to execute, with an error that
    // does not name the package.
    throw new Error(`${target}: binary is ${arch}, package advertises ${wantArch} (${binPath})`);
  }
  return { size, arch };
}

/** Is this exact name@version already on the registry? */
function alreadyPublished(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
    }).trim();
    return out === version;
  } catch {
    // E404 is "not published"; any other failure (network, auth) is treated the
    // same way here — the publish attempt below is what reports the real error.
    return false;
  }
}

/** Does the name exist at ALL, at any version? */
function nameExists(name) {
  try {
    execFileSync('npm', ['view', name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
    });
    return true;
  } catch {
    return false;
  }
}

function npmPublish(cwd) {
  return execFileSync('npm', ['publish', '--access', 'public'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const results = [];
const failed = [];

function stage(target, note) {
  results.push({ target, note });
  console.log(`  ${note.padEnd(34)} ${target}`);
}

for (const [target, spec] of Object.entries(TARGETS)) {
  if (ONLY && !ONLY.includes(target)) continue;

  const name = `@hydrascript/${target}`;
  // A bootstrap that could publish the root package would be able to ship a
  // manifest pointing at packages that do not exist yet. It cannot: the name is
  // built from the target, never from the root manifest's name.
  if (name === ROOT_PACKAGE) {
    failed.push(`${target}: refusing to publish the root package`);
    continue;
  }

  const src = path.join(DIR, target, 'bin');
  const binPath = path.join(src, spec.bin);
  if (!fs.existsSync(binPath)) {
    stage(target, 'FAIL no binary');
    failed.push(`${target}: no ${spec.bin} in ${src}`);
    continue;
  }

  let info;
  try {
    info = verifyBinary(target, binPath);
  } catch (err) {
    stage(target, 'FAIL bad binary');
    failed.push(err.message);
    continue;
  }

  // ---- idempotence: never re-publish a version that is already there --------
  const existsAtVersion = alreadyPublished(name, VERSION);
  if (existsAtVersion) {
    // Not a failure. This is what makes a re-run after a partial failure cheap:
    // the packages that made it are reported and skipped, the rest are sent.
    stage(target, `ALREADY ${VERSION}`);
    continue;
  }
  if (nameExists(name)) {
    // The name is claimed by a version that is NOT this one. Publishing a second
    // artefact under a name that already sold something is a decision, not a
    // bootstrap, so it stops here and says what is there.
    stage(target, 'FAIL name taken (other version)');
    failed.push(
      `${target}: ${name} exists at another version; this script bootstraps new names only`,
    );
    continue;
  }

  // ---- build the package ---------------------------------------------------
  const pkgDir = path.join(DIR, target, 'pkg');
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.copyFileSync(binPath, path.join(pkgDir, 'bin', spec.bin));
  fs.chmodSync(path.join(pkgDir, 'bin', spec.bin), 0o755);

  let addonNote = 'no addon on this target';
  if (spec.addon) {
    const addonPath = path.join(src, spec.addon);
    if (!fs.existsSync(addonPath)) {
      // The CLI has no napi imports (enforced in CI), so it works without the
      // addon — it spawns itself per compile instead of compiling in-process.
      // Missing is therefore a performance note, never a reason to block a
      // bootstrap. A CI run that forgot it is caught by the file count in the
      // report below.
      addonNote = 'WARNING: addon missing from the artifact';
      failed.push(`${target}: ${spec.addon} missing from the artifact (CLI works, dev is slower)`);
    } else {
      fs.copyFileSync(addonPath, path.join(pkgDir, 'bin', spec.addon));
      addonNote = 'with hydra.node';
    }
  }

  const pkg = {
    name,
    version: VERSION,
    description: `The HydraScript native compiler for ${target}.`,
    os: spec.os,
    cpu: spec.cpu,
    ...(spec.libc ? { libc: spec.libc } : {}),
    files: ['bin/'],
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/hanxthvy/hydrascript.git' },
    // A scoped package publishes PRIVATE by default, which needs a paid plan and
    // leaves `npm i hydrascript` unable to fetch it. `--access public` on the
    // command covers it; this covers anyone who runs a bare `npm publish` here.
    publishConfig: { access: 'public' },
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
      `- Binary: \`bin/${spec.bin}\` (${Math.round(info.size / 1024)} KB, ${info.arch})`,
      spec.addon
        ? '- In-process addon: `bin/hydra.node`'
        : '- No in-process addon on this target (the CLI is used)',
      '',
      'MIT.',
      '',
    ].join('\n'),
  );

  if (AUDIT) {
    stage(target, `READY ${Math.round(info.size / 1024)}KB ${info.arch} ${addonNote}`);
    continue;
  }
  if (DRY) {
    stage(target, `DRY-RUN ${Math.round(info.size / 1024)}KB ${info.arch}`);
    continue;
  }

  try {
    npmPublish(pkgDir);
    stage(target, `SENT ${VERSION}`);
  } catch (err) {
    const msg = String(err.stderr || err.message || err)
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('npm notice'))
      .slice(-3)
      .join(' ');
    // A race (another process published the same version between the check and
    // this call) is the same outcome as ALREADY, not a failure.
    if (/E409|cannot publish over|previously published/i.test(msg)) {
      stage(target, `ALREADY ${VERSION} (raced)`);
      continue;
    }
    stage(target, 'FAIL publish');
    failed.push(`${target}: ${msg}`);
  }
}

const sent = results.filter((r) => r.note.startsWith('SENT')).length;
const already = results.filter((r) => r.note.startsWith('ALREADY')).length;
const ready = results.filter((r) => r.note.startsWith('READY') || r.note.startsWith('DRY')).length;

console.log('');
console.log(`version ${VERSION}`);
console.log(`  published this run : ${sent}`);
console.log(`  already on registry: ${already}`);
if (ready) console.log(`  verified, not sent : ${ready}`);
console.log(`  failed             : ${failed.length}`);
if (failed.length) {
  console.log('');
  for (const f of failed) console.error(`  ${f}`);
}
// Exit 1 only for real failures. A missing addon is a WARNING — the CLI works
// without it (it spawns itself per compile instead of compiling in-process), and
// CI enforces that the CLI has no napi imports — so a bootstrap must not be
// blocked by a performance note. Anything else is a hard stop.
const hard = failed.filter((f) => !/addon missing/.test(f));
if (hard.length) process.exit(1);
