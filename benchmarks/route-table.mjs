// [xihanzu-NR]
/**
 * Route table GENERATION cost — the half that runs per build, not per navigation.
 *
 * Run: node benchmarks/route-table.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRoutes, routesModuleSource } from '../packages/cli/router.mjs';

for (const n of [100, 500, 2000]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gen-'));
  for (let i = 0; i < n; i++) {
    const d = path.join(dir, `s${i % 20}`, `t${i % 50}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `p${i}.hyx`), '# [xihanzu-NR]\n');
  }
  fs.writeFileSync(path.join(dir, '[slug].hyx'), '# [xihanzu-NR]\n');

  const t0 = performance.now();
  const table = scanRoutes(dir);
  const scanMs = performance.now() - t0;
  const t1 = performance.now();
  const src = routesModuleSource(table, { base: '/' });
  const genMs = performance.now() - t1;
  console.log(
    `${String(n).padStart(5)} routes: scan ${scanMs.toFixed(1)}ms, emit ${genMs.toFixed(1)}ms, module ${(src.length / 1024).toFixed(0)}KB`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}
