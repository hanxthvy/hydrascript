// [xihanzu-NR]
/**
 * Route MATCHING cost, and why the router is a linear scan on purpose.
 *
 * `matchRoute` walks the sorted table and returns the first hit. That is O(n) in
 * the number of routes, and it was measured before anything was "optimised":
 * the table is sorted most-specific-first, so the common URLs match early, and
 * the cost is per navigation rather than per render.
 *
 * Run: node benchmarks/routes.mjs
 */
import { matchRoute, compareRoutes } from '../runtime/router-core.js';

function table(n) {
  const routes = [];
  for (let i = 0; i < n; i++) {
    routes.push({
      pattern: `/p${i}/:id`,
      segments: [
        { kind: 'literal', value: `p${i}` },
        { kind: 'param', name: 'id' },
      ],
      params: ['id'],
      file: `p${i}.hyx`,
    });
  }
  routes.push({
    pattern: '/blog/:slug',
    segments: [
      { kind: 'literal', value: 'blog' },
      { kind: 'param', name: 'slug' },
    ],
    params: ['slug'],
    file: 'blog.hyx',
  });
  routes.sort(compareRoutes);
  return routes;
}

const N = 20000;
for (const size of [50, 500, 2000]) {
  const routes = table(size);
  for (const [label, url] of [['early hit', '/p0/abc'], ['late hit', `/p${size - 1}/abc`], ['miss', '/nope']]) {
    const t = performance.now();
    for (let i = 0; i < N; i++) matchRoute(url, routes);
    const us = ((performance.now() - t) / N) * 1000;
    console.log(`${String(size).padStart(4)} routes  ${label.padEnd(10)} ${us.toFixed(2)} us/call`);
  }
}
