import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const API_TARGET = process.env.FIRSTMIC_API_TARGET || 'http://localhost:4100'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 4110,
    proxy: {
      '/api': API_TARGET,
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
})
