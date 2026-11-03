// [xihanzu-NR]
/**
 * `.env`, and the rule that keeps a secret out of the browser.
 *
 * Two halves that only make sense together:
 *
 *   1. Read `.env` at the project root into `process.env`, so the SERVER side
 *      (`env()` from `hydra/server`, API routes, middleware, loaders) can read
 *      any variable. A real environment variable wins over the file, because a
 *      deploy sets its secrets in the environment and a stray `.env` in the
 *      tarball must not override them.
 *   2. Inline ONLY `PUBLIC_*` into the client bundle, and make a client file
 *      that touches anything else a BUILD ERROR naming the variable and the
 *      file. Not `undefined` at runtime: a leaked secret and a missing value
 *      look identical in a browser, and only one of them is recoverable.
 *
 * Deliberately no dotenv dependency, and deliberately no interpolation:
 * `${OTHER}` inside a value stays literal. Interpolation is a second, quieter
 * language inside a config file — and the value of `SECRET` written as
 * `${DB_PASSWORD}` is exactly the case where a reader cannot tell what the
 * build inlined.
 *
 * What is NOT read from `.env`: the framework's own knobs (`HYDRA_NO_SSG`,
 * `PORT`, ...). Those stay real environment variables so a CI job can change
 * one build without editing a file in the repo.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse `.env` text into a flat map.
 *
 * The grammar is the small one, on purpose: `KEY=VALUE` per line, `#` comments,
 * blank lines ignored, one layer of matching quotes stripped, and a trailing
 * ` #` comment removed on unquoted values. Anything else (a line with no `=`,
 * a key that is not an identifier) is skipped rather than guessed at.
 */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Keys THIS process took from a `.env` file, keyed by project.
 *
 * The distinction is what makes "the environment always wins" and "editing
 * `.env` takes effect in dev" both true: a key in here was NOT set by the shell,
 * so a later read of the file may replace it; a key that was already set when
 * the file was first read belongs to the deploy and stays. Keyed by directory so
 * two projects in one process (a test suite, a monorepo script) cannot delete
 * each other's variables.
 */
const FROM_FILE = new Set();

/**
 * Load the project's `.env` into `process.env`.
 *
 * Called by every command that can run server code (`build`, `dev`, `preview`),
 * because `hydra/server`'s `env()` reads `process.env` and nothing else — a
 * second lookup path for `.env` would be a second set of rules about precedence.
 *
 * Calling it again re-reads the file: values that came from it are replaced, a
 * key deleted from it is deleted from the environment, and a key that is the
 * shell's is never touched. That is what makes editing `.env` behave like
 * editing a source file instead of needing a restart nothing announces.
 *
 * Returns `{ file, vars, applied }`: `vars` is what the FILE said (for the
 * build log), `applied` is the keys actually written, so "my .env change did
 * nothing" has an answer in the terminal.
 */
/**
 * The `.env` files a project may have, LOWEST precedence first.
 *
 * `.env` is the base, `.env.<mode>` overrides it, and `.env.local` (then
 * `.env.<mode>.local`) overrides everything — the order Vite and Next taught
 * everyone, so a file copied from another project behaves as expected instead
 * of being silently ignored. Reading only `.env` meant `.env.local` was both
 * unignored by git AND unused by the build: the worst pair.
 */
export function envFileNames(mode = process.env.NODE_ENV || 'production') {
  return ['.env', `.env.${mode}`, '.env.local', `.env.${mode}.local`];
}

export function loadProjectEnv(cwd, target = process.env, mode = process.env.NODE_ENV || 'production') {
  // Merged in precedence order; a later file wins for the same key.
  const vars = {};
  let found = 0;
  for (const name of envFileNames(mode)) {
    const file = path.join(cwd, name);
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    if (text === null) continue;
    found += 1;
    Object.assign(vars, parseDotEnv(text));
  }
  // Nothing to read (found === 0) is fine: the `FROM_FILE` cleanup below still
  // runs, so a key this process applied earlier does not outlive its file.
  const applied = [];
  const owned = (k) => FROM_FILE.has(`${cwd}\u0000${k}`);

  // A key that vanished from the file goes with it, but only one this process
  // put there in the first place.
  for (const entry of [...FROM_FILE]) {
    const [dir, key] = entry.split('\u0000');
    if (dir !== cwd) continue;
    if (!(key in vars)) {
      delete target[key];
      FROM_FILE.delete(entry);
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    // A real environment variable wins. The deploy's secrets live there, and a
    // `.env` that shipped inside a tarball must not silently override them. A
    // key this process already took from the file is ours to update.
    if (!owned(k) && target[k] !== undefined && target[k] !== '') continue;
    target[k] = v;
    FROM_FILE.add(`${cwd}\u0000${k}`);
    applied.push(k);
  }
  // `file` is kept in the return shape for callers that log it; with several
  // files the base name is the honest one to name.
  return {
    file: found === 0 ? null : path.join(cwd, '.env'),
    files: envFileNames(mode).filter((n) => fs.existsSync(path.join(cwd, n))),
    vars,
    applied,
  };
}

/**
 * Every `PUBLIC_*` value, which is the ONLY thing the client may see.
 *
 * Written as a filter over `process.env` rather than over `.env`, so a
 * `PUBLIC_*` set by the deploy's environment reaches the bundle too — otherwise
 * "it works locally" and "it works in production" would read different files.
 */
export function publicEnvValues(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith('PUBLIC_') && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Names the build itself provides, so they are not project secrets.
 *
 * `NODE_ENV` is the one that appears in ordinary library code (`if
 * (process.env.NODE_ENV !== 'production')`) and is already replaced by the
 * `define` block; refusing it would fail every React project on day one.
 */
const BUILD_PROVIDED = new Set(['NODE_ENV']);

/** `process.env.NAME`, `process.env["NAME"]`, and the `import.meta.env` forms. */
const DOT_ACCESS = /(?:process\.env|import\.meta\.env)\.([A-Za-z_$][\w$]*)/g;
const INDEX_ACCESS = /(?:process\.env|import\.meta\.env)\s*\[/g;

/**
 * Environment references in a COMPILED client module that must fail the build.
 *
 * Compiled output, not source: a comment that mentions `process.env.API_KEY`,
 * or documentation inside a string, is not a read, and failing on it would make
 * the check something authors work around. What esbuild ships is what is
 * scanned.
 *
 * Three rules, each with a different fix:
 *
 *   - a non-`PUBLIC_` name is a secret in the open  -> move the read to a loader
 *   - a computed key (`process.env[name]`) cannot be checked OR inlined, so it
 *     would be a silent `undefined` in the browser -> write the dot form
 *   - a `PUBLIC_` name is fine, and gets inlined
 *
 * `@returns {{ name: string|null, reason: 'secret'|'computed' }[]}`
 */
export function clientEnvViolations(code) {
  const found = [];
  const text = String(code || '');
  for (const m of text.matchAll(DOT_ACCESS)) {
    const name = m[1];
    if (name.startsWith('PUBLIC_') || BUILD_PROVIDED.has(name)) continue;
    found.push({ name, reason: 'secret' });
  }
  // A computed access is reported once per site, without a name: there is no
  // name to report, and that IS the problem.
  for (let i = 0; i < text.length; i++) {
    INDEX_ACCESS.lastIndex = i;
    if (!INDEX_ACCESS.test(text)) break;
    found.push({ name: null, reason: 'computed' });
    i = INDEX_ACCESS.lastIndex;
  }
  return found;
}

/**
 * The message for one violation.
 *
 * Names the file and the variable, because the two questions a build error has
 * to answer are "which file" and "which name" — a generic "environment access
 * is not allowed" makes the author grep for it.
 */
export function describeClientEnvViolation(file, rel, v) {
  if (v.reason === 'computed') {
    return (
      `${rel}: process.env[...] with a computed key cannot be checked or inlined by the build. ` +
      `Write the dot form, \`process.env.PUBLIC_NAME\`, for a variable the client may see; ` +
      `anything else belongs in a loader or src/api, which run on the server.`
    );
  }
  return (
    `${rel}: ${v.name} is not available in the browser. Only names starting with PUBLIC_ are ` +
    `inlined into the client bundle; ${v.name} stays on the server. Read it in a loader ` +
    `(*.server.hys), an API route, or middleware — or rename it to PUBLIC_${v.name} if the ` +
    `value really is public.`
  );
}
