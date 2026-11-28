// [xihanzu-NR]
/**
 * Every snippet, expanded and parsed by the compiler.
 *
 * A snippet is a lesson in syntax that fires while you type, so a snippet with
 * a parse error teaches a mistake at the moment someone is most willing to
 * believe it. This test expands each body (placeholders replaced by their
 * defaults) and runs `hydra --check` over the result — parse only, because a
 * snippet legitimately mentions names that do not exist yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli, tempDir } from './helpers.mjs';

const SNIPPETS = path.resolve(import.meta.dirname, '..', 'snippets', 'hydrascript.json');
const file = JSON.parse(fs.readFileSync(SNIPPETS, 'utf8'));

/**
 * Replace VS Code placeholders with their defaults.
 *
 * `${1:name}` keeps `name`, `${1}` disappears, `${1|a,b|}` takes the first
 * choice. Nested defaults are handled by finding the matching brace rather than
 * by a regex, because `${3:li(key=${1:item}):}` is a real thing that appears in
 * this file and a regex gets it wrong.
 */
export function expandSnippet(body) {
  function expandText(text) {
    let index = 0;
    let out = '';
    while (index < text.length) {
      const char = text[index];
      if (char !== '$') {
        out += char;
        index += 1;
        continue;
      }
      const next = text[index + 1] ?? '';
      if (next === '{') {
        let depth = 1;
        let cursor = index + 2;
        let inner = '';
        while (cursor < text.length && depth > 0) {
          const current = text[cursor];
          if (current === '{') depth += 1;
          if (current === '}') {
            depth -= 1;
            if (depth === 0) break;
          }
          inner += current;
          cursor += 1;
        }
        index = cursor + 1;
        const colon = inner.indexOf(':');
        if (colon !== -1) {
          out += expandText(inner.slice(colon + 1));
          continue;
        }
        const choice = /^\d+\|([^|]*)\|$/.exec(inner);
        if (choice) {
          out += (choice[1].split(',')[0] || '').trim();
          continue;
        }
        continue; // a bare `${1}`
      }
      if (/[0-9]/.test(next)) {
        index += 1;
        while (/[0-9]/.test(text[index] ?? '')) index += 1;
        continue;
      }
      if (/[A-Za-z_]/.test(next)) {
        // A variable like `$TM_FILENAME`: no value here, so it goes away.
        index += 1;
        while (/[A-Za-z0-9_]/.test(text[index] ?? '')) index += 1;
        continue;
      }
      out += char;
      index += 1;
    }
    return out;
  }

  return expandText(String(body));
}

test('the snippet file is well formed', () => {
  assert.ok(Object.keys(file).length > 10, 'the file has almost nothing in it');
  for (const [name, snippet] of Object.entries(file)) {
    if (name.startsWith('_')) continue;
    assert.ok(Array.isArray(snippet.body), `${name}: body must be an array of lines`);
    assert.ok(snippet.prefix, `${name}: no prefix`);
    assert.ok(snippet.description, `${name}: no description`);
    assert.ok(snippet.scope, `${name}: no scope, so it would fire in every language`);
  }
});

test('every snippet parses once its placeholders are filled in', () => {
  const dir = tempDir('hydra-snippets-');
  const failures = [];
  for (const [name, snippet] of Object.entries(file)) {
    if (name.startsWith('_')) continue;
    const text = `${expandSnippet(snippet.body.join('\n'))}\n`;
    for (const language of String(snippet.scope).split(',').map((s) => s.trim())) {
      const target = path.join(dir, `${name.replace(/[^A-Za-z0-9]+/g, '-')}.${language}`);
      fs.writeFileSync(target, text);
      const result = runCli(['--check', target]);
      if (result.status !== 0) failures.push(`${name} (.${language}):\n${text}\n${result.output}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n---\n'));
});
