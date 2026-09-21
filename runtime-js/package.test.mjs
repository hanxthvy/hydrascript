// [xihanzu-NR]
// Self-check for serpent-js. Run: node --test runtime-js/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  range, enumerate, zip, truthy, sorted, sorted_by, reversed, sum, len,
  dict_get, dict_setdefault, dict_merge, dict_items,
  capitalize, title, format, zfill, join, split,
  int, float, at, at_key, count, index_of,
  ValueError, KeyError, IndexError,
} from './serpent-js.js'

test('range matches Python', () => {
  assert.deepEqual(range(5), [0, 1, 2, 3, 4])
  assert.deepEqual(range(2, 5), [2, 3, 4])
  assert.deepEqual(range(0, 10, 3), [0, 3, 6, 9])
  assert.deepEqual(range(5, 0, -1), [5, 4, 3, 2, 1])
  assert.deepEqual(range(0), [])
  assert.throws(() => range(0, 5, 0), RangeError)
})

test('enumerate and zip', () => {
  assert.deepEqual(enumerate(['a', 'b']), [[0, 'a'], [1, 'b']])
  assert.deepEqual(enumerate(['a'], 1), [[1, 'a']])
  assert.deepEqual(zip([1, 2, 3], ['a', 'b']), [[1, 'a'], [2, 'b']])
})

test('truthy follows Python, not JS', () => {
  assert.equal(truthy([]), false)      // JS says true
  assert.equal(truthy({}), false)      // JS says true
  assert.equal(truthy(''), false)
  assert.equal(truthy(0), false)
  assert.equal(truthy(null), false)
  assert.equal(truthy([0]), true)      // non-empty list is truthy even with falsy content
  assert.equal(truthy('0'), true)
})

test('sorted does not mutate', () => {
  const xs = [3, 1, 2]
  assert.deepEqual(sorted(xs), [1, 2, 3])
  assert.deepEqual(xs, [3, 1, 2])
  assert.deepEqual(reversed(xs), [2, 1, 3])
  assert.deepEqual(xs, [3, 1, 2])
})

test('sorted_by with key', () => {
  const people = [{ n: 'b', a: 30 }, { n: 'a', a: 20 }]
  assert.deepEqual(sorted_by(people, (p) => p.a).map((p) => p.n), ['a', 'b'])
})

test('sum, len, count, index_of', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
  assert.equal(len([1, 2]), 2)
  assert.equal(count([1, 1, 2], 1), 2)
  assert.equal(index_of([1, 2], 2), 1)
  assert.throws(() => index_of([1], 9), Error)
  assert.equal(index_of([1], 9, -1), -1)
})

test('dict helpers', () => {
  assert.equal(dict_get({ a: 1 }, 'a', 0), 1)
  assert.equal(dict_get({ a: 1 }, 'b', 0), 0)
  assert.equal(dict_get(null, 'a', 'x'), 'x')
  const d = { a: 1 }
  assert.equal(dict_setdefault(d, 'a', 9), 1)
  assert.equal(dict_setdefault(d, 'b', 9), 9)
  assert.deepEqual(d, { a: 1, b: 9 })
  assert.deepEqual(dict_merge({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
  assert.deepEqual(dict_items({ a: 1 }), [['a', 1]])
})

test('string helpers', () => {
  assert.equal(capitalize('hello world'), 'Hello world')
  assert.equal(capitalize(''), '')
  assert.equal(title('hello world'), 'Hello World')
  assert.equal(format('{} and {}', 'a', 'b'), 'a and b')
  assert.equal(zfill('7', 3), '007')
  assert.equal(join('-', ['a', 'b']), 'a-b')
  assert.deepEqual(split('a,b,c', ',', 1), ['a', 'b,c'])
})

test('int and float raise ValueError, not NaN', () => {
  assert.equal(int('42'), 42)
  assert.equal(int(3.9), 3)
  assert.throws(() => int('abc'), ValueError)
  assert.equal(float('3.14'), 3.14)
  assert.throws(() => float('x'), ValueError)
})

test('at and at_key raise like Python', () => {
  assert.equal(at([1, 2, 3], -1), 3)
  assert.throws(() => at([1], 5), IndexError)
  assert.equal(at_key({ a: 1 }, 'a'), 1)
  assert.throws(() => at_key({}, 'a'), KeyError)
})

test('error classes are catchable by type', () => {
  try {
    int('nope')
    assert.fail('should have thrown')
  } catch (e) {
    assert.ok(e instanceof ValueError)
    assert.ok(e instanceof Error)
    assert.equal(e.name, 'ValueError')
  }
})
