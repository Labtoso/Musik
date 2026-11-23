// Release build step: minifies the shipped web code in place and puts the copyright notice on top.
// Runs only on the copy that goes into a build (CI, Docker, download page), never on the sources you edit.
// Usage: node tools/protect/protect.mjs <folder> [<folder> ...]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = (() => { try { return readFileSync(join(root, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
const build = (process.env.GITHUB_SHA || process.env.STREYN_BUILD || 'local').slice(0, 10);
const NOTICE = `Streyn ${version} (${build}). Copyright (c) LabtosoStudios. All rights reserved. ` +
  'Copying, rebranding or redistributing this code or the Streyn name and design without written permission is prohibited.';

const SKIP_DIRS = new Set(['vendor', 'node_modules', 'shots']);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); }
    else if (!name.endsWith('.min.js')) files.push(p);
  }
}

const js = (code, module) => transformSync(code, {
  loader: 'js',
  minify: true,
  // modules: local names are renamed too; classic scripts keep their global names (used by onclick="")
  format: module ? 'esm' : undefined,
  legalComments: 'none',
  target: 'es2020',
  charset: 'utf8',
}).code.trim();

const inlineJs = (code) => {
  try { return js(code, false); } catch { return code; }
};

let before = 0, after = 0;
for (const dir of process.argv.slice(2)) walk(dir);
for (const f of files) {
  const ext = extname(f).toLowerCase();
  if (!['.js', '.mjs', '.css', '.html'].includes(ext)) continue;
  const src = readFileSync(f, 'utf8');
  let out;
  if (ext === '.css') {
    out = `/*! ${NOTICE} */\n` + transformSync(src, { loader: 'css', minify: true, legalComments: 'none', charset: 'utf8' }).code.trim();
  } else if (ext === '.html') {
    out = await minifyHtml(src, {
      collapseWhitespace: true,
      conservativeCollapse: true,
      removeComments: true,
      minifyCSS: true,
      minifyJS: (text, inline) => (inline ? text : inlineJs(text)),
      keepClosingSlash: true,
      caseSensitive: true,
    });
    out = out.replace(/^(<!doctype html>)?/i, (m) => `${m}<!-- ${NOTICE} -->`);
  } else {
    out = `/*! ${NOTICE} */\n` + js(src, true);
  }
  before += src.length;
  after += out.length;
  writeFileSync(f, out);
}
console.log(`protect: ${files.length} files, ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
