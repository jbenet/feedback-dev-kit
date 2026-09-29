/**
 * Shared build steps for the two packages (tsup for the JavaScript, tsc for the declarations).
 *
 * Each source file becomes one output file, so a module's 'use client' directive stays on that
 * module: a server component can still import a plain constant (VIEWPORT_BOOT) from the index
 * without it turning into a client reference. Relative imports are left external and pointed at
 * the emitted `.js` file, which Node's ESM resolver and every bundler accept.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SOURCE_EXT = /\.(?:tsx?|jsx?)$/;

/** Every .ts/.tsx under `dir`, as tsup entries. */
export function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** esbuild plugin: relative imports stay imports, rewritten to the emitted `.js`. */
export const relativeToJs = {
  name: 'relative-to-js',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      return { path: toJs(args.path, args.resolveDir), external: true };
    });
  },
};

/** './config' → './config.js', './types.ts' → './types.js', './issues' → './issues/index.js'. */
function toJs(spec, fromDir) {
  if (/\.css$/.test(spec)) return spec;
  if (SOURCE_EXT.test(spec)) return spec.replace(SOURCE_EXT, '.js');
  const abs = resolve(fromDir, spec);
  for (const ext of ['.ts', '.tsx']) if (existsSync(abs + ext)) return `${spec}.js`;
  if (existsSync(join(abs, 'index.ts')) || existsSync(join(abs, 'index.tsx'))) return `${spec}/index.js`;
  return `${spec}.js`;
}

function walk(dir, test) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, test));
    else if (test(p)) out.push(p);
  }
  return out;
}

/** Put each source module's 'use client' back on its output (esbuild drops module directives when bundling). */
export function restoreDirectives(srcDir, distDir) {
  for (const src of sourceFiles(srcDir)) {
    const head = readFileSync(src, 'utf8').trimStart();
    if (!/^['"]use client['"]/.test(head)) continue;
    const out = join(distDir, relative(srcDir, src)).replace(/\.tsx?$/, '.js');
    const js = readFileSync(out, 'utf8');
    if (!/^['"]use client['"]/.test(js)) writeFileSync(out, `'use client';\n${js}`);
  }
}

/** Declarations name the emitted files too: `from './types.ts'` / `from './config'` → `.js`. */
export function fixDeclarationSpecifiers(distDir) {
  for (const file of walk(distDir, (p) => p.endsWith('.d.ts'))) {
    const text = readFileSync(file, 'utf8');
    const fixed = text.replace(/(from\s+|import\(\s*)(['"])(\.\.?\/[^'"]+)\2/g, (whole, lead, q, spec) =>
      `${lead}${q}${toJsFromDist(spec, dirname(file))}${q}`);
    if (fixed !== text) writeFileSync(file, fixed);
  }
}

function toJsFromDist(spec, fromDir) {
  if (/\.js$/.test(spec)) return spec;
  if (/\.tsx?$/.test(spec)) return spec.replace(/\.tsx?$/, '.js');
  const abs = resolve(fromDir, spec);
  if (existsSync(`${abs}.d.ts`)) return `${spec}.js`;
  if (existsSync(join(abs, 'index.d.ts'))) return `${spec}/index.js`;
  return `${spec}.js`;
}

export function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// CLI: `node scripts/build-package.mjs fix-dts <distDir>` after tsc has written the declarations.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd === 'fix-dts' && dir) fixDeclarationSpecifiers(resolve(dir));
  else { console.error('usage: build-package.mjs fix-dts <distDir>'); process.exit(2); }
}
