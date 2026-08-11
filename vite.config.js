import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Tailwind v4 plugs straight into Vite — no postcss.config or tailwind.config needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Everything under test today is pure logic (RLE, manifest parsing, redo
  // distribution) — no DOM. Stated explicitly rather than left to Vitest's
  // default so it's an obvious edit point if a component test ever needs
  // jsdom.
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
