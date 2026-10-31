import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const skippedDirectories = new Set(['.git', '.next', '.nuxt', '.output', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'vendor']);
const slash = path => path.replaceAll('\\', '/');

// This is a bounded, literal-import inventory, not a JavaScript interpreter.
function withoutComments(text) {
  let output = '', state = 'code';
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (state === 'line') { if (char === '\n') { state = 'code'; output += char; } else output += ' '; continue; }
    if (state === 'block') { if (char === '*' && next === '/') { output += '  '; i++; state = 'code'; } else output += char === '\n' ? '\n' : ' '; continue; }
    if (state === 'code' && char === '/' && next === '/') { output += '  '; i++; state = 'line'; continue; }
    if (state === 'code' && char === '/' && next === '*') { output += '  '; i++; state = 'block'; continue; }
    if (state === 'code' && (char === '\'' || char === '"' || char === '`')) state = char;
    else if (state !== 'code' && char === '\\') { output += char + (next || ''); i++; continue; }
    else if (state !== 'code' && char === state) state = 'code';
    output += char;
  }
  return output;
}

export function literalImports(text) {
  const code = withoutComments(text);
  const pattern = /(^[ \t]*(?:import|export)[ \t]+(?:[^;'"()]{0,300}?\s+from\s*)?(['"])([^'"\r\n]+)\2)|\b(?:import|require)\s*\(\s*(['"])([^'"\r\n]+)\4\s*\)/gm;
  const results = [];
  for (const match of code.matchAll(pattern)) {
    const specifier = match[3] || match[5];
    if (!specifier) continue;
    const line = code.slice(0, match.index).split('\n').length;
    results.push({ specifier, line });
  }
  return results;
}

async function importMap(root) {
  const map = {};
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(entry => entry.isFile() && /\.html?$/i.test(entry.name))) {
    const html = await readFile(resolve(root, entry.name), 'utf8').catch(() => '');
    for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { Object.assign(map, JSON.parse(match[1]).imports || {}); } catch { /* Invalid maps are not package evidence. */ }
    }
  }
  return map;
}

function mappedSource(specifier, map) {
  if (map[specifier]) return map[specifier];
  const prefix = Object.keys(map).filter(key => key.endsWith('/') && specifier.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  return prefix ? map[prefix] + specifier.slice(prefix.length) : null;
}

export async function scanSourceImports(root, { maxFiles = 2500, maxBytes = 1024 * 1024 } = {}) {
  const files = [], errors = [], stack = [root];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => { errors.push(`${slash(relative(root, dir)) || '.'}: ${error.code || error.name}`); return []; });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !entry.name.startsWith('.')) stack.push(resolve(dir, entry.name));
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase()) && !entry.name.endsWith('.min.js')) {
        if (files.length >= maxFiles) { truncated = true; break; }
        files.push(slash(relative(root, resolve(dir, entry.name))));
      }
    }
    if (truncated) break;
  }
  files.sort();
  const fileSet = new Set(files), map = await importMap(root), imports = [];
  for (const file of files) {
    const absolute = resolve(root, file);
    const size = await stat(absolute).then(value => value.size).catch(() => 0);
    if (size > maxBytes) { errors.push(`${file}: over ${maxBytes} bytes`); continue; }
    const source = await readFile(absolute, 'utf8').catch(error => { errors.push(`${file}: ${error.code || error.name}`); return null; });
    if (source == null) continue;
    for (const found of literalImports(source)) {
      const { specifier, line } = found;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const unresolved = slash(relative(root, resolve(dirname(absolute), specifier)));
        const candidates = [unresolved, ...[...sourceExtensions].map(ext => unresolved + ext), ...[...sourceExtensions].map(ext => `${unresolved}/index${ext}`)];
        const target = candidates.find(candidate => fileSet.has(candidate)) || null;
        imports.push({ from: file, to: target, specifier, line, kind: target ? 'local' : 'unresolved-local' });
      } else if (!specifier.startsWith('node:')) {
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        imports.push({ from: file, packageName, specifier, line, kind: 'external', mappedUrl: mappedSource(specifier, map) });
      }
    }
  }
  return { files, imports, errors, truncated };
}
