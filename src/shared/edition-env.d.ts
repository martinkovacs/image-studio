/** Build-time constants (see electron.vite.config.ts / vitest.config.ts `define`).
 *
 * Note: named `edition-env.d.ts` rather than `edition.d.ts` because TypeScript 7
 * treats `<name>.d.ts` as the declaration twin of `<name>.ts` and drops it from
 * the include graph when the `.ts` implementation exists.
 */
declare const __SLIM__: boolean
