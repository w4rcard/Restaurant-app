import react from '@vitejs/plugin-react'

const host = process.env.UI_HOST || '0.0.0.0'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
