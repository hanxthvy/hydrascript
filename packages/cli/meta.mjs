// [xihanzu-NR]
/**
 * Per-page metadata: the `meta` assignment at the top of a page file.
 *
 *   # src/pages/about.hyx
 *   meta = {"title": "About — Hanz", "description": "Who writes this."}
 *
 * Two keys, `title` and `description`, and nothing else. A metadata block is
 * where a framework usually starts growing — open graph, twitter cards,
 * canonical, robots — and each of those is a promise about a page that this
 * build cannot check. So the limit is a fact rather than a hope: a third key is
 * a build error that names it, not a value that sits in the file doing nothing.
 *
 * Read from the SOURCE at scan time, the same way `rendering = "csr"` is, and
 * NOT by importing the page:
 *
 *   - the compiler emits a module-level assignment as `const meta = {...}`, not
 *     an export (checked against the real compiler), so importing the page
 *     module does not carry it;
 *   - a page module is a CLIENT module. Importing it during the build would run
 *     its top-level code and its imports in node, which is exactly the boundary
 *     `.server.hys` exists to keep.
 *
 * The build does three small things with it, all from these two values: the
 * static HTML for the route gets the `<title>` and the description tag, a route
 * a server renders per request gets the same treatment, and the generated route
 * table carries the values so a client-side navigation can put them back. No
 * public hook, no render-phase head management, no per-route config file.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The only keys `meta` may declare, in the order the docs list them. */
export const META_KEYS = ['title', 'description'];

/**
 * Read `meta` out of a page's source.
 *
 * Returns `{ meta, error }` and never throws: the scanner collects diagnostics
 * for every file it cannot read rather than dying on the first one, so a build
 * can report all of them at once. `meta` is null when the page declares none,
 * which is a perfectly valid page.
 */
export function readMeta(source) {
  // Module level means column 0. An indented `meta = ...` is inside a component
  // body and is that component's own variable, not the page's metadata.
  const at = /^meta[ \t]*=/m.exec(source);
  if (!at) return { meta: null, error: null };

  let i = at.index + at[0].length;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== '{') {
    return { meta: null, error: 'meta must be a dict of strings: meta = {"title": "...", "description": "..."}' };
  }

  const start = i;
  let depth = 0;
  let quote = null;
  let close = -1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      // A brace inside a string is text, not structure. Skipping the escaped
      // character matters too: `\}` would otherwise close the dict early.
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { meta: null, error: 'meta is missing its closing `}`' };

  try {
    return { meta: parsePairs(source.slice(start + 1, close)), error: null };
  } catch (err) {
    return { meta: null, error: err.message };
  }
}

/**
 * The dict body -> `{ title?, description? }`.
 *
 * Deliberately not `JSON.parse`: a Python dict allows a trailing comma and
 * single quotes, and both are things an author writing Python will type. The
 * grammar is otherwise the one JSON has — string keys, string values — so this
 * reads the same data with fewer surprises and a message that says which part
 * is wrong.
 */
function parsePairs(body) {
  const entries = [];
  let i = 0;
  // Whitespace only. The comma is structural: skipping it here is how the first
  // version consumed the separator and then demanded one that was already gone.
  const skip = () => {
    while (i < body.length && /\s/.test(body[i])) i++;
  };

  while (true) {
    skip();
    if (i >= body.length) break;
    const key = readString(body, i, 'a key');
    i = key.next;
    skip();
    if (body[i] !== ':') throw new Error('meta entries are written "key": "value"');
    i++;
    skip();
    const value = readString(body, i, 'a value');
    i = value.next;
    entries.push([key.value, value.value]);
    skip();
    if (i >= body.length) break;
    if (body[i] !== ',') throw new Error('meta entries are separated by `,`');
    i++;
  }

  const meta = {};
  for (const [key, value] of entries) {
    if (!META_KEYS.includes(key)) {
      throw new Error(
        `meta has the key "${key}". This build applies "title" and "description" and nothing else; ` +
          `remove it rather than leaving a value that never reaches the page.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      throw new Error(`meta declares "${key}" twice; keep one`);
    }
    meta[key] = value;
  }
  return meta;
}

/** One quoted string starting at `i`, with the handful of escapes a title needs. */
function readString(body, i, what) {
  const quote = body[i];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`meta expects ${what} in quotes, found \`${body[i] || ''}\``);
  }
  let out = '';
  let at = i + 1;
  while (at < body.length) {
    const c = body[at];
    if (c === quote) return { value: out, next: at + 1 };
    if (c === '\\') {
      const next = body[at + 1];
      const escapes = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
      if (!Object.prototype.hasOwnProperty.call(escapes, next)) {
        throw new Error(`meta contains the escape \\${next || ''}, which this build does not read`);
      }
      out += escapes[next];
      at += 2;
      continue;
    }
    out += c;
    at += 1;
  }
  throw new Error(`meta has an unterminated string for ${what}`);
}

/**
 * Write a route's meta into a complete HTML document.
 *
 * The `<title>` and the description tag are REPLACED in place, and a missing
 * description tag is added next to the title. Replacement rather than append is
 * the point: a document with two `<title>` elements shows whichever the browser
 * picks, which is the kind of bug that only shows up in a crawler.
 *
 * One escape function for both, `&` first. A title with `&` in it is ordinary
 * ("Docs & Guides") and a description with `<` is ordinary too — either one
 * written raw would end the attribute or the element early.
 */
export function applyMeta(html, meta) {
  if (!meta) return html;
  let out = html;

  if (typeof meta.title === 'string') {
    const tag = `<title>${escapeHtml(meta.title)}</title>`;
    out = /<title>[\s\S]*?<\/title>/i.test(out)
      ? out.replace(/<title>[\s\S]*?<\/title>/i, tag)
      : out.replace(/<\/head>/i, `  ${tag}\n  </head>`);
  }

  if (typeof meta.description === 'string') {
    const tag = `<meta name="description" content="${escapeHtml(meta.description)}" />`;
    const existing = /<meta\b[^>]*\bname=["']description["'][^>]*>/i;
    if (existing.test(out)) {
      out = out.replace(existing, tag);
    } else if (out.includes('</head>')) {
      out = out.replace('</head>', `  ${tag}\n  </head>`);
    }
  }

  return out;
}

/**
 * What the page was SERVED with: the title and description in its own
 * `index.html`.
 *
 * A client-side navigation to a route that declares no `meta` has to put
 * something back, and the honest answer is the shell's own value rather than
 * whatever the previous route left in `document.title`. The shell belongs to
 * the project, so it is read from the project.
 *
 * Both values are nullable: a shell with no description means pages that do not
 * declare one have none, which is different from having an empty one.
 */
export function shellMeta(cwd) {
  const empty = { title: null, description: null };
  let html;
  try {
    html = fs.readFileSync(path.join(cwd, 'index.html'), 'utf8');
  } catch {
    return empty;
  }
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const tag = /<meta\b[^>]*\bname=["']description["'][^>]*>/i.exec(html);
  const content = tag && /\bcontent=["']([^"']*)["']/i.exec(tag[0]);
  return {
    title: title ? unescapeHtml(title[1]) : null,
    description: content ? unescapeHtml(content[1]) : null,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The shell's title read back as text rather than as markup.
 *
 * `hydra init` writes `Docs &amp; Guides`; putting that string straight into
 * `document.title` from the route table would show the entity. Only the five
 * escapes this build writes are decoded, because those are the only ones its
 * own shells can contain.
 */
function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
