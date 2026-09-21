import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import serpent from 'vite-plugin-serpent'

export default defineConfig({
  plugins: [serpent(), react()],
})