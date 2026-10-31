import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path';

const ignored = new Set(['.git', '.next', '.nuxt', '.venv', '.cache', '.turbo', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'outputs', 'local']);
const evidenceNames = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.jsonc', 'requirements.txt', 'pyproject.toml', 'uv.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'Dockerfile']);
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'project';

export async function discover({ searchRoots, projects = [], maxDepth = 3, maxDirectories = 10000 }) {
  if (!Array.isArray(searchRoots) || !searchRoots.length) throw new Error('At least one --search-root is required');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error('Depth must be between 0 and 8');
  if (!Number.isInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > 100000) throw new Error('Directory limit must be between 1 and 100000');
  const configured = projects.filter(project => project.root).map(project => ({ ...project, absoluteRoot: resolve(project.root) }));
  const candidates = [], visited = new Set(), unreadableDirectories = [];
  let truncated = false;
  const walk = async (directory, depth) => {
    const path = resolve(directory);
    if (visited.has(path)) return;
    if (visited.size >= maxDirectories) { truncated = true; return; }
    visited.add(path);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { unreadableDirectories.push({ path, reason: error.code || error.name }); return; }
    const names = new Set(entries.map(entry => entry.name));
    const manifests = [...names].filter(name => evidenceNames.has(name)).sort();
    const hasGit = names.has('.git');
    if (hasGit || manifests.length) candidates.push({ path, label: basename(path), git: hasGit, manifests });
    if (depth >= maxDepth) return;
    for (const entry of entries) if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) await walk(resolve(path, entry.name), depth + 1);
  };
  for (const root of searchRoots) {
    if (!isAbsolute(root)) throw new Error(`Search root must be absolute: ${root}`);
    const selected = resolve(root);
    if (selected === parse(selected).root) throw new Error(`Search root is a filesystem or drive root; choose a narrower project parent directory: ${selected}`);
    const state = await stat(selected).catch(() => null);
    if (!state?.isDirectory()) throw new Error(`Search root is not an accessible directory: ${root}`);
    await walk(selected, 0);
  }
  for (const candidate of candidates) {
    const exact = configured.find(project => project.absoluteRoot === candidate.path);
    const parent = configured.filter(project => inside(candidate.path, project.absoluteRoot) && candidate.path !== project.absoluteRoot).sort((a, b) => b.absoluteRoot.length - a.absoluteRoot.length)[0];
    const repo = candidates.filter(item => item.git && item.path !== candidate.path && inside(candidate.path, item.path)).sort((a, b) => b.path.length - a.path.length)[0];
    candidate.status = exact ? 'configured' : parent ? 'nested-unscanned' : repo ? 'nested-in-unlisted-repo' : 'unlisted';
    candidate.projectId = exact?.id || parent?.id || null;
    candidate.parentRepo = repo?.path || null;
    candidate.suggestedId = exact?.id || slug((parent?.id || (repo ? basename(repo.path) : '')) + (parent || repo ? '-' : '') + basename(candidate.path));
    candidate.action = exact ? 'already-scanned-at-root' : parent || repo ? 'review-as-package-root' : 'review-and-add-project';
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), searchRoots: searchRoots.map(root => resolve(root)), directoriesVisited: visited.size, truncated, incomplete: truncated || unreadableDirectories.length > 0, unreadableDirectories, candidates };
}

export function configuredProjects(config, configFile) {
  return (config.projects || []).map(project => ({ ...project, root: project.root ? resolve(dirname(resolve(configFile)), project.root) : null }));
}

export function upsertRoot(config, { id, label, root }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new Error('Project ID must use lowercase letters, digits, and hyphens');
  if (!root || !isAbsolute(root)) throw new Error('Root must be an absolute directory path');
  if (resolve(root) === parse(resolve(root)).root) throw new Error('Project root must be narrower than a filesystem or drive root');
  const projects = [...(config.projects || [])];
  const index = projects.findIndex(project => project.id === id);
  if (index < 0) {
    projects.push({ id, label: label || basename(root), root: resolve(root) });
  } else {
    projects[index] = { ...projects[index], ...(label ? { label } : {}), root: resolve(root) };
  }
  return { ...config, projects };
}

export function adoptDiscovery(config, report, { nestedLocks = false, configFile = process.cwd() } = {}) {
  const projects = [...(config.projects || [])], paths = new Set(projects.filter(project => project.root).map(project => resolve(dirname(resolve(configFile)), project.root)));
  const ids = new Set(projects.map(project => project.id));
  const added = [];
  for (const candidate of report.candidates || []) {
    const lock = candidate.manifests?.some(name => ['package-lock.json', 'pnpm-lock.yaml'].includes(name));
    if (candidate.status !== 'unlisted' && !(nestedLocks && candidate.status.startsWith('nested-') && lock)) continue;
    const root = resolve(candidate.path);
    if (paths.has(root)) continue;
    let id = candidate.suggestedId || slug(basename(root));
    if (ids.has(id)) {
      const stem = slug(`${basename(dirname(root))}-${basename(root)}`);
      id = stem;
      for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
    }
    const parentLabel = candidate.projectId ? projects.find(project => project.id === candidate.projectId)?.label : candidate.parentRepo ? basename(candidate.parentRepo) : null;
    const project = { id, label: parentLabel ? `${parentLabel} · ${candidate.label || basename(root)}` : candidate.label || basename(root), root };
    projects.push(project); added.push(project); paths.add(root); ids.add(id);
  }
  return { config: { ...config, projects }, added };
}
