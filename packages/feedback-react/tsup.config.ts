import { defineConfig } from 'tsup';
// A plain .mjs helper shared by both packages (scripts/build-package.mjs).
import { copy, relativeToJs, restoreDirectives, sourceFiles } from '../../scripts/build-package.mjs';

export default defineConfig({
  entry: sourceFiles('src'),
  outDir: 'dist',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false, // declarations come from tsc (tsconfig.build.json): TypeScript 7 has no JS API for tsup to call
  esbuildPlugins: [relativeToJs],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  async onSuccess() {
    restoreDirectives('src', 'dist');
    copy('src/styles.css', 'dist/styles.css');
  },
});
