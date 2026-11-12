// [xihanzu-NR]
/**
 * `hydraconfig.json` validation, driven by the shipped `schema.json`.
 *
 * Why this exists: the config used to be a bare `JSON.parse` in a try/catch, so
 * a typo'd key was silently ignored and the build ran on defaults. `porrt`,
 * `hostt` and `renderingg` built green at exit 0, and the operator's first
 * evidence of a mistake was a server on the wrong port — or none at all. An
 * unknown key is almost always a misspelling, and the cheapest place to say so
 * is the line where the file is read.
 *
 * Dependency-free on purpose. The framework's only runtime dependency is
 * esbuild, and adding a JSON-schema package to validate one file would be a
 * larger supply-chain surface than the problem it solves. This supports the
 * subset `schema.json` actually uses: `type`, `enum`, `const`, `minimum`,
 * `maximum`, `items`, `properties`, `additionalProperties`, `required`,
 * `oneOf`.
 *
 * The schema is the single source of truth for the docs and for editors too, so
 * the scaffold writes a config that validates against it — the mismatch between
 * the two is checked by a test, not left to drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(HERE, '..', '..', 'schema.json');

let cachedSchema = null;

/** The shipped schema. Cached: it is read once per process and never changes. */
export function loadSchema(schemaPath = SCHEMA_PATH) {
  if (schemaPath === SCHEMA_PATH && cachedSchema) return cachedSchema;
  const text = fs.readFileSync(schemaPath, 'utf8');
  const parsed = JSON.parse(text);
  if (schemaPath === SCHEMA_PATH) cachedSchema = parsed;
  return parsed;
}

/**
 * The JSON type name of a value, as the schema vocabulary spells it.
 *
 * `integer` is distinguished from `number` because `{"port": 5173.5}` is a
 * different mistake from `{"port": "5173"}` and should say so.
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Does `value` satisfy `type`, where `type` may be one name or a list? */
function matchesType(value, type) {
  const names = Array.isArray(type) ? type : [type];
  const actual = typeOf(value);
  return names.some((name) => {
    if (name === 'number') return actual === 'integer' || actual === 'number';
    return name === actual;
  });
}

/**
 * Validate `value` against `schema`.
 *
 * Returns a list of `{ path, message }`, deepest-first order preserved. An empty
 * list means valid. `path` is a dotted/bracketed path a person can find in
 * their file (`server.port`, `styling[0]`), not a JSON Pointer, because the
 * person reading it is looking at JSON in an editor.
 */
export function validate(value, schema, path = '') {
  const errors = [];
  const here = path || '(root)';

  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const wanted = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    errors.push({ path: here, message: `expected ${wanted}, got ${typeOf(value)}` });
    // A wrong type makes every other check noise ("expected integer, got string"
    // plus "must be one of 1..65535"). One sentence per key.
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path: here, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      path: here,
      message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
    });
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: here, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: here, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    let re = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      re = null; // a broken pattern in the schema is not the project's problem
    }
    if (re && !re.test(value)) {
      errors.push({ path: here, message: 'does not match the expected format' });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validate(item, schema.items, `${path}[${i}]`));
    });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path: key, message: 'is required' });
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(...validate(child, props[key], childPath));
        continue;
      }
      if (schema.additionalProperties === false) {
        // The suggestion matters more than the refusal: a key that is one edit
        // away from a real one is almost always a typo, and naming the intended
        // key turns "unknown key" into a fix.
        const near = closestKey(key, Object.keys(props));
        errors.push({
          path: childPath,
          message: near ? `unknown key (did you mean "${near}"?)` : 'unknown key',
        });
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(child, schema.additionalProperties, childPath));
      }
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const attempts = schema.oneOf.map((branch) => ({
      branch,
      errors: validate(value, branch, path),
    }));
    if (!attempts.some((a) => a.errors.length === 0)) {
      // Report the branch that got closest rather than all of them: three
      // contradictory sentences about one value is how a validator becomes
      // something people turn off.
      //
      // "Closest" prefers a branch whose TYPE accepts the value: given
      // `"bodyLimit": "big"`, "expected integer, got string" is true but useless,
      // while "does not match the expected format" points at the actual mistake.
      const ranked = attempts
        .slice()
        .sort((a, b) => {
          const aType = a.errors.length === 1 && /^expected /.test(a.errors[0].message) ? 1 : 0;
          const bType = b.errors.length === 1 && /^expected /.test(b.errors[0].message) ? 1 : 0;
          if (aType !== bType) return aType - bType;
          return a.errors.length - b.errors.length;
        });
      const best = ranked[0].errors;
      if (best.length > 0) errors.push(...best);
      else errors.push({ path: here, message: 'does not match any allowed shape' });
    }
  }

  return errors;
}

/** Levenshtein distance, bounded: only used for "did you mean". */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** The declared key closest to `key`, when one is close enough to be a typo. */
function closestKey(key, keys) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of keys) {
    const d = distance(String(key).toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Roughly "one edit per four characters, and never more than 3": `porrt` →
  // `port` yes, `renderingg` → `rendering` yes, `database` → `base` no.
  const limit = Math.min(3, Math.max(1, Math.floor(String(key).length / 4)));
  return bestDistance <= limit ? best : null;
}

/**
 * A byte count from a number or a size string.
 *
 * `server.bodyLimit: "10mb"` used to be passed straight to a `size > limit`
 * comparison, which is always false against a string — so setting a limit in the
 * friendlier form REMOVED the limit instead of raising it. Accepting the string
 * and converting it once is the honest fix; the alternative (rejecting it) would
 * break configs written against the README's own examples.
 *
 * Returns `null` for anything unparseable, so the caller decides whether that is
 * fatal.
 */
export function parseByteSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const scale = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
  }[unit];
  const out = Math.floor(n * scale);
  return out > 0 ? out : null;
}

/**
 * Read and validate a project's config.
 *
 * Returns `{ config, path, errors, missing }`. `missing` is true when there is no
 * file at all — a legal state (every key has a default), and different from a
 * file that exists and is wrong.
 */
export function readConfigFile(cwd) {
  const configPath = path.join(cwd, 'hydraconfig.json');
  if (!fs.existsSync(configPath)) {
    return { config: {}, path: configPath, errors: [], missing: true, parseError: null };
  }
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    return {
      config: {},
      path: configPath,
      errors: [],
      missing: false,
      parseError: `could not be read: ${e.message}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The position is what makes this actionable: "Unexpected token } in JSON at
    // position 84" names a character offset nobody can count, so the line and
    // column are derived from it here.
    return {
      config: {},
      path: configPath,
      errors: [],
      missing: false,
      parseError: `is not valid JSON (${jsonPosition(text, e)})`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      config: {},
      path: configPath,
      errors: [{ path: '(root)', message: `expected an object, got ${typeOf(parsed)}` }],
      missing: false,
      parseError: null,
    };
  }

  let errors = [];
  try {
    errors = validate(parsed, loadSchema());
  } catch (e) {
    // A broken schema is a framework bug, not the project's fault. Say so and let
    // the build continue on defaults rather than blocking on our own file.
    return {
      config: parsed,
      path: configPath,
      errors: [],
      missing: false,
      parseError: null,
      schemaError: e.message,
    };
  }

  return { config: parsed, path: configPath, errors, missing: false, parseError: null };
}

/** `line 4, column 12` for a `JSON.parse` failure, from its position offset. */
function jsonPosition(text, err) {
  const m = /position (\d+)/.exec(String(err && err.message ? err.message : ''));
  if (!m) return 'unparseable';
  const at = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  return `line ${line}, column ${column}`;
}

/** One line per problem, in the shape a person can paste into a search box. */
export function formatConfigErrors(configPath, errors) {
  const shown = path.basename(configPath);
  return errors.map((e) => `${shown}: ${e.path}: ${e.message}`).join('\n');
}
