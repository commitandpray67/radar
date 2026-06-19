import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `mode` is 'production' for `vite build`, 'development' for the dev server.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward /api/* to the FastAPI backend during development
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Don't ship source maps in production — they expose full source in the
    // shipped desktop app. Keep them for dev/preview builds.
    sourcemap: mode !== 'production',
  },
}))
