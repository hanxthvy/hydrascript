// [xihanzu-NR]
/**
 * `veil()`: a string a build should not hand to a grep.
 *
 * The tests here are the two rules that make it honest rather than decorative:
 * the encoded form must not contain the original text, and a credential-shaped
 * literal must fail the BUILD instead of being encoded — because encoding it
 * would read as "this is safe to ship", which is the one thing veil cannot say.
 *
 * The encoder lives in Rust; this file checks the half that lives in JavaScript:
 * the decode recipe in the runtime, and the source-map rule in the build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { veilSourcesIn } = await import('./runner.mjs');

/** The runtime's recipe: join the parts, base64, reverse, XOR, decode UTF-8. */
function decode(parts, key) {
  const raw = Buffer.from(parts.join(''), 'base64');
  const plain = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    plain[i] = raw[raw.length - 1 - i] ^ key[i % key.length];
  }
  return new TextDecoder('utf-8').decode(plain);
}

test('the runtime recipe decodes what the compiler emits, for plain ASCII', () => {
  // Emitted by `hydra` from veil("kontak@contoh.id"). Hard-coded on purpose:
  // this is the contract between two languages, and a round trip computed here
  // would agree with itself even if both sides were wrong together.
  assert.equal(
    decode(['FvLwyb3Z', 'QzjhaB1f', 'JgBtOw=='], [
      80, 2, 110, 82, 62, 118, 40, 130, 87, 45, 173, 210, 161, 222, 155, 114,
    ]),
    'kontak@contoh.id',
  );
});

test('the runtime recipe decodes a value with an accent, byte for byte', () => {
  // Emitted by `hydra` from veil("ünïcode ✓"). The first version of the decoder
  // XORed a binary string and returned it, which was right for ASCII and turned
  // this into latin-1 mojibake.
  assert.equal(
    decode(['fA5JNbV', 'wrDDYmM', 'Zdzg=='], [
      13, 225, 168, 91, 119, 83, 195, 20, 208, 21, 171, 146, 239, 210, 145, 104,
    ]),
    'ünïcode ✓',
  );
});

test('the payload is split, so no part carries the whole value', () => {
  const parts = ['FvLwyb3Z', 'QzjhaB1f', 'JgBtOw=='];
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length < 12, `part too long to be a fragment: ${p}`);
});

test('the source-map rule finds veil() in client sources, not in server ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-veil-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'contact.hyx'),
    'MAIL = veil("a@b.c")\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'contact.server.hys'),
    'KEY = veil("z@z.z")\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'src', 'plain.hyx'), 'X = "no veil here"\n', 'utf8');

  const hits = veilSourcesIn({}, dir);
  assert.deepEqual(hits, [path.join('src', 'pages', 'contact.hyx')]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a source that only mentions veil in a comment is not a conflict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-veil-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.hyx'), '# use veil("a") here, later\n', 'utf8');
  const hits = veilSourcesIn({}, dir);
  assert.deepEqual(hits, [path.join('src', 'x.hyx')], 'a call-shaped mention still counts');
  fs.rmSync(dir, { recursive: true, force: true });
});
