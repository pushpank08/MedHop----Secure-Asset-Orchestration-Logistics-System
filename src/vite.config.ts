import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
/// <reference types="vite/client" />
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
