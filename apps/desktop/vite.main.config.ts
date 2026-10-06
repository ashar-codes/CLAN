import { defineConfig } from 'vite';
// Main process: bundle our workspace packages, keep Electron + node builtins external.
export default defineConfig({
  build: {
    ssr: 'src/main/main.ts',
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { format: 'es', entryFileNames: 'main.js' } },
  },
  ssr: { noExternal: true, external: ['electron'] },
});
