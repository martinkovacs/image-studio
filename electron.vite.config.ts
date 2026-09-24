import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

// Edition selected at build time: "full" (default, bundles the sd.cpp engine)
// or "slim" (OpenRouter-only, resolves to `true` for the `__SLIM__` constant).
const define = { __SLIM__: JSON.stringify(process.env.IMAGE_STUDIO_EDITION === 'slim') }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared }, define },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared }, define },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    define
  }
})
