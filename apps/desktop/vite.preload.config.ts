import { defineConfig } from 'vite';
// Sandboxed preloads must be CommonJS.
export default defineConfig({
  build: {
    ssr: 'src/preload/preload.ts',
    outDir: 'dist/preload',
    emptyOutDir: true,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'preload.cjs' } },
  },
  ssr: { noExternal: true, external: ['electron'] },
});
