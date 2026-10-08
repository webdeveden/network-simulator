import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': process.env.API_TARGET ?? 'http://127.0.0.1:8010',
    },
  },
})
