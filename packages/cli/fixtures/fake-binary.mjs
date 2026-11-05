// [xihanzu-NR]
/**
 * Fixtures for the bootstrap-publisher tests: a file that LOOKS like a compiler
 * binary to the verifier, for any target, without needing the real artifacts.
 *
 * Why this exists: the first version of these tests copied real binaries from
 * `/tmp/plat`, which exists on one machine after one CI run. On a clean checkout
 * — which is what CI is — the fixtures were missing and five tests failed in
 * `prepublishOnly`, blocking a release for a reason that had nothing to do with
 * the release. A test that needs an artifact nobody checked in is not a test.
 *
 * The verifier reads exactly three things: the container magic, the CPU field,
 * and a size floor. This produces all three, in the real header layout, so the
 * verification logic is exercised for real — what is fake is only the compiler
 * code the headers describe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Minimum size the verifier accepts, plus room so a fixture is never borderline. */
const SIZE = 256 * 1024;

const TARGETS = {
  'linux-x64': { os: ['linux'], cpu: ['x64'], libc: ['glibc'], bin: 'hydra', addon: 'hydra.node' },
  'linux-arm64': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'], bin: 'hydra', addon: 'hydra.node' },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'], bin: 'hydra', addon: null },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'], bin: 'hydra', addon: null },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'], bin: 'hydra', addon: 'hydra.node' },
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'], bin: 'hydra', addon: 'hydra.node' },
  'win32-x64': { os: ['win32'], cpu: ['x64'], bin: 'hydra.exe', addon: 'hydra.node' },
};

const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 };
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };

/** A buffer whose first bytes are the real header for `container` + `cpu`. */
export function fakeBinary(container, cpu, size = SIZE, version = null) {
  const buf = Buffer.alloc(size, 0);
  if (container === 'elf') {
    // 0x7f 'E' 'L' 'F', then e_machine (LE) at offset 18.
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buf, 0);
    buf.writeUInt8(2, 4); // ELFCLASS64
    buf.writeUInt8(1, 5); // little endian
    buf.writeUInt16LE(2, 16); // ET_EXEC
    buf.writeUInt16LE(ELF_MACHINE[cpu], 18);
  } else if (container === 'macho') {
    // MH_MAGIC_64 (little-endian on disk) + cputype at offset 4.
    buf.writeUInt32BE(0xfeedfacf, 0);
    buf.writeUInt32LE(MACHO_CPU[cpu], 4);
  } else if (container === 'pe') {
    // 'MZ', e_lfanew at 0x3c, then 'PE\0\0' and the COFF Machine field.
    buf.write('MZ', 0, 'ascii');
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write('PE\0\0', 0x80, 'binary');
    buf.writeUInt16LE(PE_MACHINE[cpu], 0x84);
  } else {
    throw new Error(`unknown container ${container}`);
  }
  if (version) {
    // A real compiler embeds its own version from CARGO_PKG_VERSION, and the
    // publisher reads it back out of the bytes to prove the artifact matches
    // the release. A fixture without it would pass tests that the real binary
    // cannot, so this mirrors reality rather than simplifying it.
    Buffer.from(`\0hydra ${version}\0`, 'latin1').copy(buf, 256);
  }
  return buf;
}

function containerFor(target) {
  if (target.startsWith('linux')) return 'elf';
  if (target.startsWith('darwin')) return 'macho';
  return 'pe';
}

/**
 * Build an artifact directory shaped like the one `binaries.yml` uploads:
 * `<dir>/<target>/bin/hydra` and, where the platform has one, `hydra.node`.
 *
 * `overrides` lets a test put a WRONG binary somewhere on purpose — that is how
 * the architecture check is tested without a real cross-build.
 */
export function makeArtifacts(targets, { overrides = {}, version = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-fixture-'));
  for (const t of targets) {
    const spec = TARGETS[t];
    if (!spec) throw new Error(`unknown target ${t}`);
    const binDir = path.join(dir, t, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const ov = overrides[t] || {};
    const container = ov.container || containerFor(t);
    const cpu = ov.cpu || spec.cpu[0];
    const binPath = path.join(binDir, spec.bin);
    fs.writeFileSync(binPath, fakeBinary(container, cpu, ov.size, version));
    fs.chmodSync(binPath, 0o755);

    if (spec.addon && ov.addon !== false) {
      fs.writeFileSync(path.join(binDir, spec.addon), fakeBinary(container, cpu, undefined, version));
    }
  }
  return dir;
}

export { TARGETS };
