// [xihanzu-NR]
/**
 * Reproduce the dev-mode crash outside a browser.
 *
 * The browser said `Cannot assign to read only property 'undefined' of
 * #<Window>` inside the refresh registry. That message means a computed key was
 * `undefined`, and the only way to see which one is to run the actual bundle
 * against a `globalThis` that behaves like a window and refuse to guess.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

// A minimal window: `globalThis` already has the property names the bundle uses,
// and a stray assignment to an existing non-writable one throws the same way.
const sandbox = new Proxy(globalThis, {
  set(target, key, value) {
    if (typeof key === 'symbol' || key === undefined || key === null || key === 'undefined') {
      throw new TypeError(
        `assignment to a computed key that is ${String(key)} — this is the bug: ` +
          `the registry code did globalThis[${String(key)}] = ...`,
      );
    }
    target[key] = value;
    return true;
  },
});

try {
  // `new Function` runs with globalThis as its scope, which is what a browser
  // module does. Importing it as ESM would hide the failure behind its own loader.
  const run = new Function('globalThis', 'window', 'document', 'self', src);
  run(sandbox, sandbox, { getElementById: () => null, createElement: () => ({}), body: {} }, sandbox);
  console.log('ran without throwing');
} catch (e) {
  console.log('THREW:', e.message);
  const m = /at ([^\s]+) \(?/.exec(e.stack || '');
  console.log('first frame:', m ? m[1] : '(none)');
  console.log((e.stack || '').split('\n').slice(0, 6).join('\n'));
}
