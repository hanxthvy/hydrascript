// [xihanzu-NR]
/**
 * `hydra test` — end to end, on a real project.
 *
 * The reason there are so many assertions per case: while writing this runner
 * it reported "5 passed" for a file whose only assertion was false. A test
 * runner that always says pass is worse than no runner at all, so the tests
 * below check the report, not only that the command exits.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from './runner.mjs';
import { findTestFiles, testRoot, parseTestOutput, readSnapshots } from './testing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

/** A project with one component and one test file. */
function project({ testBody } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 't', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'Card.hyx'),
    '# [xihanzu-NR]\ncomponent Card(title: str = "none", items: list = []):\n    div(cls="card"):\n        h2(cls="t"): title\n',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'card.test.hys'),
    testBody ??
      [
        '# [xihanzu-NR]',
        'from "hydra/test" import test, expect, render, snapshot',
        'from "../src/Card.hyx" import Card',
        '',
        'def renders():',
        '    expect(render(Card, {"title": "hi"})).to_contain("hi")',
        '',
        'def fails():',
        '    expect(render(Card, {"title": "hi"})).to_contain("nope")',
        '',
        'def snaps():',
        '    snapshot("card", render(Card, {"title": "s"}))',
        '',
        'test("renders", renders)',
        'test("fails", fails)',
        'test("snapshot", snaps)',
        '',
      ].join('\n'),
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

test('discovery finds *.test.hys under tests/, src/ or the root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-disc-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.hys'), '#\n');
  fs.writeFileSync(path.join(dir, 'tests', 'b.test.hyx'), '#\n');
  fs.writeFileSync(path.join(dir, 'tests', 'notatest.hys'), '#\n');
  const root = testRoot(dir, {});
  assert.ok(root && root.endsWith('tests'), `expected tests/, got ${root}`);
  const found = findTestFiles(root).map((f) => path.basename(f));
  assert.deepEqual(found, ['a.test.hys', 'b.test.hyx']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the results block is parsed, and its absence is not a pass', () => {
  const block = parseTestOutput('noise\n__HYDRA_TEST_RESULTS__[{"name":"a","ok":true}]\n');
  assert.deepEqual(block, [{ name: 'a', ok: true }]);
  assert.equal(parseTestOutput('nothing here'), null);
  assert.equal(parseTestOutput('__HYDRA_TEST_RESULTS__not json'), null);
});

test('a passing test passes, a failing test fails, and it says which', async () => {
  const dir = project();
  const out = [];
  const errors = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  let code;
  try {
    code = await runTests(dir, {});
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  const text = out.join('\n');

  // The exit code is the contract CI depends on.
  assert.equal(code, 1, 'a failing test must make the run fail');
  assert.match(text, /ok\s+tests\/card\.test\.hys › renders/);
  assert.match(text, /FAIL tests\/card\.test\.hys › fails/);
  // ...and the failure explains itself, with the actual value.
  assert.match(text, /expected the value to contain "nope"/);
  assert.match(text, /hi/);
  assert.match(text, /1 passed, 1 failed|2 passed, 1 failed/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a test file that does not compile fails the run and shows the compiler message', async () => {
  const dir = project({ testBody: '# [xihanzu-NR]\nthis is not hydrascript(((\n' });
  const out = [];
  const errors = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  let code;
  try {
    code = await runTests(dir, {});
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /does not compile/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a snapshot is written on the first run, then compared, then updatable', async () => {
  const dir = project();
  const quiet = async () => {
    const realLog = console.log;
    const realErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return await runTests(dir, {});
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
  };

  await quiet();
  const { data } = readSnapshots(dir);
  const key = Object.keys(data).find((k) => k.includes('card'));
  assert.ok(key, `a snapshot must have been written, got ${JSON.stringify(data)}`);
  assert.match(data[key], /class="t"/);

  // Changing the component changes the snapshot, and that is a FAILURE, not a
  // silent rewrite: a snapshot nobody notices changing catches nothing.
  fs.writeFileSync(
    path.join(dir, 'src', 'Card.hyx'),
    '# [xihanzu-NR]\ncomponent Card(title: str = "none", items: list = []):\n    div(cls="card"):\n        h1(cls="t"): title\n',
  );
  const out = [];
  const realLog = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    await quiet();
    // `quiet` swallows console; re-run with it visible.
    console.log = (...a) => out.push(a.join(' '));
    await runTests(dir, {});
  } finally {
    console.log = realLog;
  }
  assert.match(out.join('\n'), /snapshot "card" changed/);

  // SNAP_UPDATE=1 accepts it.
  process.env.SNAP_UPDATE = '1';
  try {
    await quiet();
  } finally {
    delete process.env.SNAP_UPDATE;
  }
  assert.match(readSnapshots(dir).data[key], /<h1 class="t">/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt snapshot file is an error, not an empty baseline', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.hydra'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hydra', 'snapshots.json'), '{not json');
  assert.throws(() => readSnapshots(dir), /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the snapshot diff points at the changed line, not the whole document', async () => {
  // Driven through the real runner, on a three-line snapshot with ONE line
  // changed. A naive implementation prints both documents and leaves the reader
  // to compare them by eye; the assertion is that the changed line is marked,
  // the unchanged ones are shown for context, and the output is not a dump.
  const dir = project({
    testBody: [
      '# [xihanzu-NR]',
      'from "hydra/test" import test, snapshot',
      '',
      'def snap():',
      '    snapshot("multi", "one\\ntwo\\nthree")',
      '',
      'test("snap", snap)',
      '',
    ].join('\n'),
  });
  const capture = async () => {
    const lines = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    try {
      return { code: await runTests(dir, {}), text: lines.join('\n') };
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
  };

  const first = await capture(); // writes the baseline
  assert.equal(first.code, 0, `the baseline run must pass:\n${first.text}`);

  fs.writeFileSync(
    path.join(dir, 'tests', 'card.test.hys'),
    [
      '# [xihanzu-NR]',
      'from "hydra/test" import test, snapshot',
      '',
      'def snap():',
      '    snapshot("multi", "one\\nCHANGED\\nthree")',
      '',
      'test("snap", snap)',
      '',
    ].join('\n'),
  );

  const second = await capture();
  assert.equal(second.code, 1, 'a changed snapshot must fail the run');
  assert.match(second.text, /snapshot "multi" changed/);
  assert.match(second.text, /^\s*- two$/m, `the removed line must be marked:\n${second.text}`);
  assert.match(second.text, /^\s*\+ CHANGED$/m, `the added line must be marked:\n${second.text}`);
  assert.match(second.text, /^\s+one$/m, 'unchanged lines are shown for context');
  assert.match(second.text, /SNAP_UPDATE=1/, 'the way out is part of the message');

  fs.rmSync(dir, { recursive: true, force: true });
});
