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

/**
 * `--otp <code>`, optional.
 *
 * Held in a module-local for the lifetime of this process and nowhere else: not
 * written to a file, not put in the environment, not part of any message. It is
 * passed to npm as an argv element because that is the only interface npm
 * offers (`npm publish --otp=...`); the value is therefore visible to `ps` for
 * the duration of the call, which is inherent to npm's own design, and is one
 * more reason the interactive path is the default and this is the shortcut.
 *
 * Never printed. Every message in this file that mentions OTP talks about the
 * FLAG, never the value.
 */
const OTP = (() => {
  const at = args.indexOf('--otp');
  if (at === -1) return null;
  const value = args[at + 1];
  // Validate here rather than at the registry: an empty or malformed code would
  // be sent, refused, and reported as an authentication failure, which sends the
  // reader looking at their token instead of their typing.
  if (value === undefined || value === '') {
    console.error('--otp needs a value: the 6-digit code from your authenticator');
    process.exit(2);
  }
  if (!/^\d{6}$/.test(value)) {
    // Deliberately does NOT echo the value: a mistyped OTP may be a mistyped
    // something-else.
    console.error('--otp must be exactly 6 digits. The value is not repeated here on purpose.');
    process.exit(2);
  }
  return value;
})();

/** The arguments that carry the OTP to npm, or none. Never logged. */
function otpArgs() {
  return OTP ? [`--otp=${OTP}`] : [];
}

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

/**
 * The version a compiler binary was built at.
 *
 * Two ways, because one is not enough:
 *
 *   1. run it — correct, and proves the artifact executes on this machine;
 *   2. if it cannot run (a cross-architecture artifact, which is the normal case
 *      when publishing seven targets from one box), find the version STRING in
 *      the binary itself. The compiler embeds it from `CARGO_PKG_VERSION`, so it
 *      is present as plain bytes in all three container formats.
 *
 * Returns null when neither works, and the caller refuses to publish: guessing a
 * version is how the wrong build ships under the right number.
 */
function readBinaryVersion(binPath) {
  try {
    // `stdio: 'ignore'` on stderr is not tidiness. Running an arm64 ELF on x64
    // makes the SHELL print "ELF\x02\x01... not found" and "Syntax error: word
    // unexpected" — noise that appears above the real output, and text that a
    // version scraper could mistake for a finding. The attempt is expected to
    // fail for six of the seven targets when publishing from one box.
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {
    // Expected for a foreign architecture; fall through to the bytes.
  }
  try {
    const buf = fs.readFileSync(binPath);
    // Latin1 keeps one byte per character, so the whole file scans as text
    // without a decode failure on binary.
    //
    // The question is narrow on purpose: does this file contain the EXACT version
    // about to be published? Not "what version is this" — a compiled artifact is
    // full of semver strings from its dependencies (a real binary here contains
    // 0.1.0 five times, 19.1.0 four, 0.32.3 three), and picking the most frequent
    // one is how an earlier version of this function reported a dependency's
    // version as the compiler's.
    //
    // An exact match is the only answer that is both safe and useful: if the
    // bytes say 0.13.2, this is a 0.13.2 build; if they do not, it is not.
    const text = buf.toString('latin1');
    const wanted = VERSION.split('.').join('\\.');
    return new RegExp(`(?:^|[^0-9.])${wanted}(?![0-9.])`).test(text) ? VERSION : null;
  } catch {
    return null;
  }
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

/**
 * What the registry said about one query.
 *
 * Three DISTINCT outcomes, not a boolean. The old version collapsed "not
 * published" with "could not find out" into `false`, so a timeout or an auth
 * failure read as "the package is not there" and the script would try to
 * publish over a version that already existed — the exact thing the idempotence
 * check exists to prevent.
 */
const PRESENT = 'present';
const ABSENT = 'absent';
const UNKNOWN = 'unknown';

/** Run `npm view` and classify the answer. */
function viewVersion(spec, { timeoutMs = 20000 } = {}) {
  try {
    const out = execFileSync('npm', ['view', spec, 'version', ...otpArgs()], {
      encoding: 'utf8',
      // stdin closed: `npm view` cannot prompt, and a prompt that hangs is worse
      // than an error. The OTP travels as an argument when one was supplied.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
    return { state: PRESENT, value: out.split('\n').pop().trim() };
  } catch (err) {
    const stderr = String(err.stderr || '');
    const msg = String(err.message || '');
    // A 404 from the registry is the ONLY answer that means "not published".
    // npm spells it `E404` and prints `404 Not Found`; the two patterns below
    // are the forms both the CLI and the registry use.
    if (/E404|404 Not Found|code E404/.test(stderr) || /E404/.test(msg)) {
      return { state: ABSENT };
    }
    if (err.killed || /ETIMEDOUT|timed? ?out/i.test(msg) || err.signal) {
      return { state: UNKNOWN, reason: `timed out after ${timeoutMs}ms` };
    }
    if (/EOTP|one-time password/i.test(stderr) || /EOTP/.test(msg)) {
      return { state: UNKNOWN, reason: 'the registry wants a one-time password' };
    }
    if (/E401|E403|Unauthorized|Forbidden/i.test(stderr) || /E40[13]/.test(msg)) {
      return { state: UNKNOWN, reason: 'authentication was refused' };
    }
    // Anything else is still "I do not know", never "absent".
    return { state: UNKNOWN, reason: (stderr.split('\n').find((l) => l.trim()) || msg).slice(0, 160) };
  }
}

/** `npm publish`, with the real TTY attached so npm can prompt. */
function npmPublish(cwd, { timeoutMs = 300000 } = {}) {
  // `inherit`, not pipes.
  //
  // npm only shows its OTP prompt when `process.stdin.isTTY` is true, and with
  // `stdio: ['ignore', ...]` it is /dev/null — so npm threw EOTP without ever
  // asking. `inherit` hands it this process's terminal, which is what makes the
  // interactive path work at all.
  //
  // The cost is that npm's own output (and its OTP prompt) goes to our stdout,
  // which is the point: a prompt the user cannot see is a prompt that does not
  // exist. The package name is printed before the call so the prompt is not
  // ambiguous, and nothing here ever prints a token — npm does not either.
  execFileSync('npm', ['publish', '--access', 'public', ...otpArgs()], {
    cwd,
    stdio: 'inherit',
    timeout: timeoutMs,
  });
}

/**
 * Is there an authenticated npm session?
 *
 * Checked BEFORE the first publish attempt. Without it the registry answers an
 * anonymous PUT with `404 Not Found` rather than 401 — deliberately, so it does
 * not reveal that a name exists — and the failure reads as "this package cannot
 * be published", which sends the reader looking at trusted publishers and
 * package ownership instead of at `npm login`.
 *
 * `npm whoami` is the cheapest question that distinguishes those two worlds.
 */
function requireNpmSession() {
  try {
    const who = execFileSync('npm', ['whoami'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    }).trim();
    if (!who) throw new Error('empty');
    return who;
  } catch {
    console.error('');
    console.error('  npm is not logged in, so publishing cannot work.');
    console.error('');
    console.error('  The registry answers an anonymous PUT with 404, not 401, which is');
    console.error('  why the error above looked like a permissions problem on the package.');
    console.error('');
    console.error('    npm login          # then run this again');
    console.error('');
    process.exit(2);
  }
}

const results = [];
const failed = [];

function stage(target, note) {
  results.push({ target, note });
  console.log(`  ${note.padEnd(34)} ${target}`);
}

// Audit and dry-run must keep working with no session at all — they are what a
// person runs to CHECK the artifacts before logging in.
if (!AUDIT && !DRY) {
  const who = requireNpmSession();
  console.log(`  npm session: ${who}`);
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

  // The binary must be the SAME VERSION as the package about to be published.
  //
  // Artifacts are downloaded from a CI run, and a directory from an older run
  // looks identical: same layout, same file names, a compiler that builds. The
  // version is the only thing that says whether it is the right build, so it is
  // read from the binary itself and compared before anything else happens.
  // Reading `--version` only works when the binary can RUN here. A cross-target
  // artifact (arm64 on an x64 box, PE on Linux) cannot, and the failure is an
  // exec format error rather than a wrong answer — so the version is read from
  // the BYTES when execution is impossible, and execution is preferred when it
  // works because it proves the artifact is runnable at all.
  const binaryVersion = readBinaryVersion(binPath);
  if (binaryVersion !== VERSION) {
    stage(target, `FAIL binary is ${binaryVersion || '?'}, package is ${VERSION}`);
    failed.push(
      `${target}: ${spec.bin} reports ${binaryVersion || 'an unreadable version'}, but this run publishes ${VERSION}. ` +
        'The artifact directory is from a different build — download the one for this version.',
    );
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
  const atVersion = viewVersion(`${name}@${VERSION}`);
  if (atVersion.state === PRESENT && atVersion.value === VERSION) {
    // Not a failure. This is what makes a re-run after a partial failure cheap:
    // the packages that made it are reported and skipped, the rest are sent.
    stage(target, `ALREADY ${VERSION}`);
    continue;
  }
  if (atVersion.state === UNKNOWN) {
    // The registry did not answer. That is NOT evidence the package is absent —
    // publishing on a guess is how a version gets written twice or a name gets
    // claimed by the wrong build. Stop for this target and say why.
    stage(target, 'FAIL cannot tell if it exists');
    failed.push(`${target}: could not query the registry (${atVersion.reason}); not publishing blind`);
    continue;
  }

  const anyVersion = viewVersion(name);
  if (anyVersion.state === UNKNOWN) {
    stage(target, 'FAIL cannot tell if it exists');
    failed.push(`${target}: could not query the registry (${anyVersion.reason}); not publishing blind`);
    continue;
  }
  if (anyVersion.state === PRESENT) {
    // The name exists at a DIFFERENT version. That is the normal case for every
    // release after the first: 0.13.1 is on the registry, 0.13.2 is not, and
    // publishing 0.13.2 is exactly what should happen.
    //
    // This used to refuse, on the reasoning that a second artefact under a name
    // that had already sold something was a decision rather than a bootstrap.
    // True for a NAME, wrong for a VERSION — and it made the script unusable for
    // the second release it was ever asked to do.
    //
    // What still must not happen is publishing under a name owned by someone
    // else, and the registry enforces that: the PUT is refused. The version
    // comparison above already guarantees no existing version is overwritten.
    console.log(`  note: ${name} is on the registry at ${anyVersion.value}; adding ${VERSION}`);
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
    // Printed BEFORE the call: npm's own prompt appears next, and a bare
    // "Enter OTP:" with no context does not say which of seven packages it is.
    console.log(`  publishing ${name}@${VERSION} ...`);
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
