// [xihanzu-NR]
/**
 * The last gate before `npm publish`: the manifest must name its platform
 * packages.
 *
 * The repo's own `package.json` carries `optionalDependencies: {}`. Only
 * `release.yml` wires the seven `@hydrascript/*` packages in, at publish time.
 * So a publish from a laptop — `npm publish` after bumping the version, which is
 * the obvious thing to do — puts a root package on npm whose installer resolves
 * NOTHING. It installs cleanly on Linux x86-64 and then every command on every
 * other platform dies with "no compiler for this platform", and npm versions are
 * immutable, so there is nothing to take back.
 *
 * `prepublishOnly` runs before the tarball is built, which is exactly the last
 * moment this is still a warning instead of a postmortem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const TARGETS = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];

// Trusted publishing is the sanctioned path: `release.yml` holds the OIDC
// identity, wires the manifest, runs the suites, and attests provenance. A local
// publish is not blocked outright — someone may deliberately need one — but it
// does not get to skip the check that is the whole reason this file exists.
const inCi = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';

const deps = pkg.optionalDependencies || {};
const missing = TARGETS.filter((t) => deps[`@hydrascript/${t}`] !== pkg.version);
const extra = Object.keys(deps).filter((n) => !TARGETS.some((t) => n === `@hydrascript/${t}`));

if (missing.length || extra.length) {
  const lines = [
    '',
    `refusing to publish ${pkg.name}@${pkg.version}: the platform wiring is incomplete.`,
    '',
  ];
  if (missing.length) {
    lines.push('  missing or at the wrong version:');
    for (const t of missing) lines.push(`    @hydrascript/${t}@${pkg.version}`);
  }
  if (extra.length) {
    lines.push('  unexpected entries:');
    for (const n of extra) lines.push(`    ${n}`);
  }
  lines.push(
    '',
    '  Publishing this manifest installs nothing on most platforms, and the',
    '  version cannot be unpublished afterwards.',
    '',
    '  Publish through the `release` workflow (trusted publishing): it wires',
    '  these in after the platform packages exist. See .github/workflows/release.yml.',
    '',
  );
  process.stderr.write(lines.join('\n'));
  if (!inCi) {
    process.stderr.write(
      '  (Override for a deliberate one-off with HYDRA_ALLOW_UNWIRED_PUBLISH=1.)\n\n',
    );
    if (process.env.HYDRA_ALLOW_UNWIRED_PUBLISH === '1') process.exit(0);
  }
  process.exit(1);
}

const wired = TARGETS.length;
console.log(`platform wiring ok: ${wired} targets at ${pkg.version}`);
