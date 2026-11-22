// [xihanzu-NR]
/**
 * Codemods: the registry behind `hydra migrate <from> <to>`.
 *
 * Why the contract exists before any codemod does: every release that breaks
 * something is supposed to ship a migration, and a migration written as a regex
 * over source text is the kind of tool that works on the example in the changelog
 * and eats the string literal that looks like it. This repository owns its
 * parser, so a codemod here can be structural — and the moment the shape is
 * settled, writing one is cheap. Settling it late is what makes people stop
 * upgrading, which is the failure the whole policy exists to prevent.
 *
 * A change is deliberately narrow:
 *
 *   {
 *     from: '0.15', to: '0.16',      // the version step it belongs to
 *     file: /\.hyx$/,                // which sources it touches
 *     describe: 'one line for the log',
 *     apply(text, path) -> text,      // pure: same input, same output
 *   }
 *
 * `apply` must be pure and must be idempotent: running the migration twice has to
 * be the same as running it once, because the second run is what happens when
 * somebody is not sure whether they already did it.
 */

/** Every codemod this version knows. Empty until the first breaking change. */
export const MIGRATIONS = [];

/**
 * The codemods that take a project from one version to another.
 *
 * Compared as `major.minor`, so `0.15.3 → 0.16.0` and `0.15 → 0.16` are the same
 * step. Patch numbers never carry a migration: a patch release that needs one is
 * not a patch release.
 */
export function migrationsFor(from, to) {
  const key = (v) => String(v || '').trim().split('.').slice(0, 2).join('.');
  const a = key(from);
  const b = key(to);
  return MIGRATIONS.filter((m) => key(m.from) === a && key(m.to) === b);
}

/** A line per registered codemod, for `hydra migrate --list`. */
export function describeMigrations() {
  if (MIGRATIONS.length === 0) return [];
  return MIGRATIONS.map((m) => `${m.from} → ${m.to}  ${m.describe}`);
}
