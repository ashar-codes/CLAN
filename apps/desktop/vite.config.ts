import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // The workspace also hosts React Native's React; never let two copies into the renderer bundle.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
