/**
 * Edition flag, resolved at build time by the `__SLIM__` define
 * (electron.vite.config.ts / vitest.config.ts).
 *
 * slim  = OpenRouter only: no stable-diffusion.cpp engine, no local provider.
 * full  = OpenRouter + local sd.cpp engine (default).
 */
export const IS_SLIM: boolean = typeof __SLIM__ !== 'undefined' && __SLIM__
