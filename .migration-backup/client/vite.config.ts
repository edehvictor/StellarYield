/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router')
          ) {
            return 'vendor-react';
          }
          if (
            id.includes('@stellar/stellar-sdk') ||
            id.includes('@stellar/freighter-api')
          ) {
            return 'vendor-stellar';
          }
          if (
            id.includes('node_modules/recharts/') ||
            id.includes('node_modules/d3') ||
            id.includes('node_modules/d3-')
          ) {
            return 'vendor-charts';
          }
          if (
            id.includes('node_modules/three/') ||
            id.includes('@react-three/')
          ) {
            return 'vendor-three';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
