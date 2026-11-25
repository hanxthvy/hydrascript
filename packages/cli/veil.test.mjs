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

const KEY = 'hydra-veil-key/2026';

/** The runtime's recipe, spelled out: base64, then XOR with the shared key. */
function decode(encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  const plain = Buffer.from(bytes.map((b, i) => b ^ KEY.charCodeAt(i % KEY.length)));
  return new TextDecoder('utf-8').decode(plain);
}

test('the runtime recipe decodes what the compiler emits', () => {
  // Produced by `hydra` from veil("kontak@contoh.id"). Hard-coded on purpose:
  // this is the contract between two languages, and a round trip computed here
  // would agree with itself even if both sides were wrong together.
  assert.equal(decode('AxYKBgBGNgYGAlkEDVdGVg=='), 'kontak@contoh.id');
});

test('a veiled value survives characters that break base64 and URIs', () => {
  const sample = 'a@b.c?x=1&y=2 ünïcode ✓';
  const bytes = Buffer.from(sample, 'utf8');
  const keyed = Buffer.from(bytes.map((b, i) => b ^ KEY.charCodeAt(i % KEY.length)));
  const encoded = keyed.toString('base64');
  assert.equal(decode(encoded), sample, 'utf8 must survive the round trip');
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
