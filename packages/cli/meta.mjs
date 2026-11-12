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
 * The keys `generateMetadata` may return, and the tag each one becomes.
 *
 * Deliberately a fixed allowlist with a fixed tag shape rather than "whatever
 * you put in the object". A metadata block is where a framework usually starts
 * growing a template language, and an open-ended one is an injection surface:
 * `title` from a database row would otherwise reach the document unescaped, or
 * a key would be emitted as an attribute name chosen by the data. Every value
 * here is escaped as text, and every tag is built by this file.
 *
 * `og:*` and `twitter:*` are included because their absence was the concrete
 * complaint: a share card with no title is worse than no share card, and SSG is
 * HydraScript's own selling point, so the pages most likely to be shared were
 * the ones with nothing to share.
 */
export const RICH_META_KEYS = [
  'title',
  'description',
  'canonical',
  'og:title',
  'og:description',
  'og:image',
  'og:type',
  'og:url',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
];

/** Length caps. A 4 KB title is a bug in the caller, not a design choice. */
const MAX_META_LEN = 2000;

/**
 * Validate what a `generateMetadata` returned.
 *
 * Throws rather than dropping a key: a metadata function that returns
 * `{titel: "..."}` and gets silence ships a page with no title, and the person
 * who wrote the typo has no way to find out. The message names the key.
 */
export function validateRichMeta(input, where = 'generateMetadata()') {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${where} must return a dict, got ${Array.isArray(input) ? 'a list' : typeof input}`);
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!RICH_META_KEYS.includes(key)) {
      throw new Error(
        `${where} returned "${key}", which this build does not apply. ` +
          `Supported: ${RICH_META_KEYS.join(', ')}.`,
      );
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`${where} returned "${key}" as ${typeof value}; metadata values are strings`);
    }
    const text = String(value);
    if (text.length > MAX_META_LEN) {
      throw new Error(`${where} returned "${key}" at ${text.length} characters (max ${MAX_META_LEN})`);
    }
    out[key] = text;
  }
  return out;
}

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
    // `() => tag`, not `tag`. A replacement STRING interprets `$&`, `` $` `` and
    // `$'` as "the match", "the text before" and "the text after", so a page title
    // of `A$&B` spliced the previous `<title>` element into the new one. Escaping
    // does not help: `$` is not HTML. One function kills the whole class, here and
    // in every other insertion below.
    out = /<title>[\s\S]*?<\/title>/i.test(out)
      ? out.replace(/<title>[\s\S]*?<\/title>/i, () => tag)
      : out.replace(/<\/head>/i, () => `  ${tag}\n  </head>`);
  }

  if (typeof meta.description === 'string') {
    const tag = `<meta name="description" content="${escapeHtml(meta.description)}" />`;
    const existing = /<meta\b[^>]*\bname=["']description["'][^>]*>/i;
    if (existing.test(out)) {
      out = out.replace(existing, () => tag);
    } else if (out.includes('</head>')) {
      out = out.replace('</head>', () => `  ${tag}\n  </head>`);
    }
  }

  // og:/twitter:/canonical. Built here, never templated, so a value from a
  // database cannot become markup. `canonical` is a <link>; the rest are
  // property= (Open Graph) or name= (Twitter) meta tags.
  if (typeof meta.canonical === 'string') {
    out = upsertTag(out, '<link rel="canonical"', `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`);
  }
  for (const [key, attr] of [
    ['og:title', 'property'],
    ['og:description', 'property'],
    ['og:image', 'property'],
    ['og:type', 'property'],
    ['og:url', 'property'],
    ['twitter:card', 'name'],
    ['twitter:title', 'name'],
    ['twitter:description', 'name'],
    ['twitter:image', 'name'],
  ]) {
    const value = meta[key];
    if (typeof value !== 'string') continue;
    out = upsertTag(
      out,
      `<meta ${attr}="${key}"`,
      `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`,
    );
  }

  return out;
}

/**
 * Replace the tag that starts with `matcher`, or insert one before `</head>`.
 *
 * Replace rather than append: a document with two `<meta property="og:title">`
 * shows whichever the crawler reads first, which is the one from the shell, not
 * the page. The same reason the title replacement above exists.
 */
function upsertTag(html, matcher, tag) {
  const escaped = matcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}[^>]*>`, 'i');
  // Function replacer: see the note on the title above — a value containing `$&`
  // must not be read as a pattern, and metadata can come from a database.
  if (re.test(html)) return html.replace(re, () => tag);
  return html.includes('</head>') ? html.replace(/<\/head>/i, () => `  ${tag}\n  </head>`) : html;
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
