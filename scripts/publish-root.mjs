// [xihanzu-NR]
/**
 * Publish the ROOT package with its platform packages wired in — the one step
 * `release.yml` does that a plain `npm publish` does not.
 *
 * Why this exists: the root manifest must NAME the seven per-platform packages
 * before it is published. Publish it without that field and `npm i hydrascript`
 * installs and then dies at the first command, because there is no compiler in
 * the tarball; publish it with an EMPTY field and the failure is the same, one
 * step later. Both are unrecoverable by the person who hit it — npm does not
 * allow replacing a published version — so the wiring is not optional and is not
 * something to remember by hand.
 *
 * Usage:
 *   node scripts/publish-root.mjs --otp=123456      # publish
 *   node scripts/publish-root.mjs --dry-run         # wire, pack, restore, publish nothing
 *   node scripts/publish-root.mjs --tag=next        # publish under a dist-tag
 *
 * The manifest is restored on every exit path, including a failure, so a run
 * that 2FA-rejects you does not leave optionalDependencies in your worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'package.json');

const TARGETS = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};

const dryRun = flag('dry-run') === true;
const otp = flag('otp');
const tag = flag('tag');

const npmView = (name) => {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: ROOT,
    }).trim();
  } catch {
    return '';
  }
};

const original = fs.readFileSync(MANIFEST, 'utf8');
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  fs.writeFileSync(MANIFEST, original);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  restore();
  process.exit(130);
});

const pkg = JSON.parse(original);
const version = pkg.version;

// The same refusal release.yml makes, for the same reason: a root that names a
// package which is not there is a 404 with no explanation.
const absent = TARGETS.map((t) => `@hydrascript/${t}`).filter((name) => npmView(name) !== version);
if (absent.length) {
  console.error(
    `these platform packages are not on npm at ${version}, so the root manifest would point at nothing:\n  ` +
      absent.join('\n  ') +
      '\nRun the binaries workflow for this tag first.',
  );
  process.exit(1);
}

pkg.optionalDependencies = Object.fromEntries(TARGETS.map((t) => [`@hydrascript/${t}`, version]));
fs.writeFileSync(MANIFEST, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[publish-root] optionalDependencies: ${TARGETS.length} targets at ${version}`);

const args = ['publish', '--access', 'public'];
if (tag) args.push('--tag', tag);
if (otp) args.push('--otp', otp);
if (dryRun) args.push('--dry-run');

try {
  execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' });
  console.log(dryRun ? '[publish-root] dry run finished, nothing published' : `[publish-root] published hydrascript@${version}`);
} finally {
  restore();
  console.log('[publish-root] package.json restored');
}
