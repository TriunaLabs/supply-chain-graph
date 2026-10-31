#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, parse } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanSourceImports } from './source-imports.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const options = (name) => args.flatMap((value, index) => value === `--${name}` && args[index + 1] ? [args[index + 1]] : []);
const help = () => {
  console.error('Usage: supply-chain.mjs init --out FILE | discover --search-root DIR [--search-root DIR] [--config FILE] --out FILE [--depth 0..8] [--max-directories N] | adopt-discovery --config FILE --discovery FILE --out FILE [--nested-locks] | set-root --config FILE --id ID --root DIR --out FILE [--label NAME] | scan --config FILE --out FILE | enrich --snapshot FILE --out FILE [--project ID] | advisory-details --snapshot FILE --out FILE | render --snapshot FILE --out FILE | diff --previous FILE --current FILE --out FILE | serve --config FILE --snapshot FILE --out HTML [--state FILE] [--port N]. Use --out - for stdout except serve.');
  process.exitCode = 2;
};
const json = async (file) => JSON.parse(await readFile(resolve(file), 'utf8'));
const output = async (file, data) => { if (file === '-') { process.stdout.write(data); return; } await mkdir(dirname(resolve(file)), { recursive: true }); await writeFile(resolve(file), data); };
const outputLabel = file => file === '-' ? 'stdout' : resolve(file);
const stable = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const pkgName = (location) => location.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1] ?? null;
const fields = [['dependencies', 'runtime'], ['devDependencies', 'development'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']];
const gitHubRepo = (value) => {
  if (typeof value !== 'string') return null;
  const m = value.match(/(?:github\.com[:/]|^github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/?]|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
};
const sourceKind = (value) => {
  if (!value) return 'unknown';
  if (gitHubRepo(value)) return 'github-git';
  if (/^https?:\/\//.test(value)) return 'registry-or-tarball';
  if (/^(?:file:|link:)/.test(value)) return 'local';
  return 'other';
};
const git = (root, ...argv) => {
  try { return execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
  catch { return null; }
};
const lookup = (packages, parent, name) => {
  let location = parent;
  while (true) {
    const candidate = location ? `${location}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!location) break;
    const parentLocation = location.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
    location = parentLocation === location ? '' : parentLocation;
  }
  return null;
};
const readSource = async (root, name) => {
  try { return { state: 'present', text: await readFile(resolve(root, name), { encoding: 'utf8', signal: AbortSignal.timeout(15000) }) }; }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'error', reason: error.name === 'AbortError' ? 'Timed out reading file' : `Read failed (${error.code || error.name})` };
  }
};
const readJsonSource = async (root, name) => {
  const source = await readSource(root, name);
  if (source.state !== 'present') return source;
  try { return { state: 'present', value: JSON.parse(source.text.replace(/^\uFEFF/, '')) }; }
  catch (error) {
    const location = error.message.match(/line (\d+) column (\d+)/);
    return { state: 'error', reason: location ? `Invalid JSON at line ${location[1]}, column ${location[2]}` : 'Invalid JSON syntax' };
  }
};
const yamlScalar = (s) => s?.trim().replace(/^['"]|['"]$/g, '').replace(/''/g, "'") ?? '';
const yamlEntry = (line) => {
  const match = line.match(/^( *)(?:'((?:[^']|'')*)'|"([^"]*)"|([^:]+)):(?:\s+(.*))?$/);
  return match && { indent: match[1].length, key: yamlScalar(match[2] ?? match[3] ?? match[4]), value: yamlScalar(match[5] ?? '') };
};
const parsePnpmV9 = (text) => {
  const body = text.replace(/^\uFEFF/, '').split(/^---\s*$/m).at(-1);
  if (!/^lockfileVersion:\s*['"]?9\./m.test(body)) throw new Error('Only pnpm lockfile v9 is supported');
  const importers = new Map(), snapshots = new Map();
  let section = '', importer = '', group = '', dependency = '', snap = '';
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = yamlEntry(line);
    if (!entry) continue;
    const { indent, key, value } = entry;
    if (indent === 0) { section = key; importer = group = dependency = snap = ''; continue; }
    if (section === 'importers') {
      if (indent === 2) { importer = key; importers.set(importer, {}); }
      else if (indent === 4) { group = key; if (fields.some(([f]) => f === group)) importers.get(importer)[group] = {}; }
      else if (indent === 6 && importers.get(importer)?.[group]) { dependency = key; importers.get(importer)[group][dependency] = {}; }
      else if (indent === 8 && importers.get(importer)?.[group]?.[dependency]) importers.get(importer)[group][dependency][key] = value;
    } else if (section === 'snapshots') {
      if (indent === 2) { snap = key; snapshots.set(snap, {}); }
      else if (indent === 4) { group = key; if (fields.some(([f]) => f === group)) snapshots.get(snap)[group] = {}; }
      else if (indent === 6 && snapshots.get(snap)?.[group]) snapshots.get(snap)[group][key] = value;
    }
  }
  return { importers, snapshots };
};

async function renderHtml(snapshot) {
  const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
  const [template, style, app] = await Promise.all(['dashboard.html', 'dashboard.css', 'dashboard.js'].map(name => readFile(resolve(assets, name), 'utf8')));
  const embedded = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return template.replace('/*__STYLE__*/', style).replace('/*__SNAPSHOT__*/null', embedded).replace('/*__APP__*/', app);
}

async function scan(configFile, includeGit = true) {
  const config = await json(configFile);
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('Config needs a nonempty projects array');
  const { discover, configuredProjects } = await import('./discover.mjs');
  const discovery = Array.isArray(config.searchRoots) && config.searchRoots.length ? await discover({ searchRoots: config.searchRoots.map(root => resolve(dirname(resolve(configFile)), root)), projects: configuredProjects(config, configFile), maxDepth: config.discoveryDepth ?? 3, maxDirectories: config.discoveryMaxDirectories ?? 10000 }) : null;
  const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), coverage: [], nodes: [], edges: [], findings: [], ...(discovery ? { discovery } : {}) };
  const nodes = new Map();
  const edges = new Map();
  const addNode = (node) => nodes.set(node.id, node);
  const addEdge = (edge) => edges.set(`${edge.from}|${edge.to}|${edge.kind}|${edge.scope ?? ''}`, edge);
  const addFinding = (id, projectId, type, title, evidence, detail = null) => snapshot.findings.push({ id, projectId, type, severity: 'coverage', title, evidence, detail });
  const seen = new Set();
  for (const [projectIndex, project] of config.projects.entries()) {
    console.error(`Scanning ${projectIndex + 1}/${config.projects.length}: ${project.id}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(project.id ?? '') || seen.has(project.id)) throw new Error(`Invalid or duplicate project ID: ${project.id}`);
    seen.add(project.id);
    if (project.root != null && typeof project.root !== 'string') throw new Error(`Invalid root for ${project.id}`);
    const root = project.root ? resolve(dirname(resolve(configFile)), project.root) : null;
    if (root && root === parse(root).root) throw new Error(`Project ${project.id} root must be narrower than a filesystem or drive root`);
    const id = `project:${project.id}`;
    const projectNode = { id, kind: 'project', label: project.label || project.id, projectId: project.id, rootPath: root, sourceStatus: 'Local directory scanned' };
    addNode(projectNode);
    const record = { projectId: project.id, npm: 'not-found', source: 'not-found', git: includeGit ? 'not-found' : 'not-scanned', actions: 'not-found', python: 'not-found' };
    let rootError = null;
    const rootState = root ? await stat(root).catch(error => { rootError = error; return null; }) : null;
    if (!rootState?.isDirectory()) {
      const status = !root ? 'path-not-configured' : rootError?.code === 'ENOENT' ? 'path-missing' : rootError?.code === 'EACCES' ? 'access-denied' : 'unavailable';
      record.npm = status; record.source = status; record.git = status; record.actions = status; record.python = status;
      const reason = !root ? 'No path is configured for this project.' : rootError?.code === 'ENOENT' ? 'The configured path does not exist on this machine.' : rootError?.code === 'EACCES' ? 'Access to the configured path was denied.' : 'The configured path is not an accessible directory.';
      projectNode.sourceStatus = reason;
      addFinding(`root-unavailable:${project.id}`, project.id, 'root-unavailable', !root ? 'No project source path is configured' : 'Configured project source is inaccessible', 'portfolio config', reason);
      snapshot.coverage.push(record);
      continue;
    }
    const manifestSource = await readJsonSource(root, 'package.json');
    const npmSource = await readJsonSource(root, 'package-lock.json');
    const pnpmSource = await readSource(root, 'pnpm-lock.yaml');
    const manifest = manifestSource.value, lock = npmSource.value;
    const sourceScan = await scanSourceImports(root);
    record.source = sourceScan.truncated || sourceScan.errors.length ? 'partial' : sourceScan.files.length ? 'scanned' : 'not-found';
    record.sourceFiles = sourceScan.files.length;
    record.sourceImports = sourceScan.imports.length;
    if (record.source === 'partial') addFinding(`source-partial:${project.id}`, project.id, 'source-scan-partial', 'JavaScript source scan was incomplete', 'source files', `${sourceScan.files.length} files considered. ${sourceScan.truncated ? 'File limit reached. ' : ''}${sourceScan.errors.slice(0, 3).join('; ')}`);
    const importingFiles = new Set(sourceScan.imports.map(item => item.from));
    for (const file of importingFiles) {
      const fileId = `source:${project.id}:${file}`;
      addNode({ id: fileId, kind: 'source-file', label: file, projectId: project.id, location: file, ecosystem: 'JavaScript source' });
      addEdge({ from: id, to: fileId, kind: 'has-source-imports', source: file });
    }
    for (const item of sourceScan.imports) {
      const from = `source:${project.id}:${item.from}`;
      const evidence = `${item.from}:${item.line}`;
      if (item.kind === 'local') {
        const target = `source-target:${project.id}:${item.to}`;
        addNode({ id: target, kind: 'source-file', label: item.to, projectId: project.id, location: item.to, ecosystem: 'JavaScript source', sourceStatus: 'Local import target' });
        addEdge({ from, to: target, kind: 'imports-local', scope: item.specifier, source: evidence });
      } else if (item.kind === 'unresolved-local') {
        const target = `source-unresolved:${project.id}:${item.specifier}`;
        addNode({ id: target, kind: 'source-import', label: `${item.specifier} (unresolved)`, projectId: project.id, sourceStatus: 'Local target not found in scanned source files' });
        addEdge({ from, to: target, kind: 'imports-unresolved', scope: item.specifier, source: evidence });
      } else {
        const target = `source-package:${project.id}:${item.packageName}`;
        const versionHint = item.mappedUrl?.match(/\/npm\/(?:@[^/]+\/)?[^/@]+@([^/]+)/)?.[1] || null;
        addNode({ id: target, kind: 'source-import', label: item.packageName, name: item.packageName, projectId: project.id, ecosystem: 'JavaScript source', sourceKind: item.mappedUrl ? 'browser import map' : 'bare import, source unresolved', sourceStatus: item.mappedUrl ? 'Mapped URL in root HTML; package installation not verified' : 'Observed in source; resolved version and origin unknown', mappedUrl: item.mappedUrl, versionHint });
        addEdge({ from, to: target, kind: 'imports-external', scope: item.specifier, source: evidence, mappedUrl: item.mappedUrl });
      }
    }
    const rootDeclarations = new Map();
    if (manifest) for (const [field, scope] of fields) for (const [name, requested] of Object.entries(manifest[field] || {})) {
      const did = `decl:js:${project.id}:root:${scope}:${name}`;
      addNode({ id: did, kind: 'declaration', label: `${name} ${requested}`, name, requested, ecosystem: 'JavaScript', projectId: project.id });
      addEdge({ from: id, to: did, kind: 'declares', scope, source: 'package.json' });
      rootDeclarations.set(`${scope}:${name}`, did);
    }
    if (manifestSource.state === 'error') addFinding(`manifest:${project.id}`, project.id, 'manifest-error', 'JavaScript manifest needs attention', 'package.json', manifestSource.reason);
    if (npmSource.state === 'error') addFinding(`lock:${project.id}`, project.id, 'lockfile-error', 'npm lockfile needs attention', 'package-lock.json', npmSource.reason);
    if (pnpmSource.state === 'error') addFinding(`pnpm-lock:${project.id}`, project.id, 'lockfile-error', 'pnpm lockfile needs attention', 'pnpm-lock.yaml', pnpmSource.reason);
    const usePnpm = pnpmSource.state === 'present' && (manifest?.packageManager?.startsWith('pnpm@') || !lock);
    if (lock && pnpmSource.state === 'present') addFinding(`multiple-locks:${project.id}`, project.id, 'multiple-lockfiles', 'Both npm and pnpm lockfiles are present', 'package-lock.json + pnpm-lock.yaml', usePnpm ? 'Using pnpm because packageManager selects it.' : 'Using npm; set packageManager to disambiguate.');
    if (manifest && npmSource.state === 'absent' && pnpmSource.state === 'absent') {
      record.npm = 'manifest-only';
      const count = fields.reduce((total, [field]) => total + Object.keys(manifest[field] || {}).length, 0);
      const externalCount = sourceScan.imports.filter(item => item.kind === 'external').length;
      addFinding(`missing-lock:${project.id}`, project.id, 'missing-lockfile', count ? `${count} declared JavaScript dependencies have no root lockfile` : externalCount ? `No root lockfile or declared dependencies; ${externalCount} external source imports found` : 'Root package.json has no lockfile or root dependencies', 'package.json', count ? 'Requested ranges are visible, but installed versions and transitive paths are unknown.' : externalCount ? 'Open the Source imports lens to inspect file paths and import map URLs. Source imports do not establish installed versions or transitive dependencies.' : 'Check the Source imports lens and any nested manifests. No installed versions or transitive paths can be inferred.');
    }
    if (!manifest && !lock && pnpmSource.state === 'absent') {
      const nested = discovery?.candidates.filter(candidate => candidate.projectId === project.id && candidate.status === 'nested-unscanned' && candidate.manifests.some(name => name === 'package.json' || name === 'pnpm-lock.yaml')) || [];
      if (nested.length) {
        record.npm = 'nested-unscanned';
        addFinding(`nested-js:${project.id}`, project.id, 'nested-manifest', `${nested.length} nested JavaScript source${nested.length === 1 ? '' : 's'} not scanned`, 'discovery', 'Add the relevant nested root as a project or configure a package-root adapter.');
      }
    }
    if (lock && manifestSource.state === 'absent') addFinding(`missing-manifest:${project.id}`, project.id, 'missing-manifest', 'npm lockfile has no package.json at the project root', 'package-lock.json');
    if (manifest && lock && !usePnpm) {
      if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') {
        record.npm = 'unsupported';
        addFinding(`unsupported-lock:${project.id}`, project.id, 'unsupported-lockfile', 'npm lockfile format is unsupported by this starter', 'package-lock.json');
      } else {
        record.npm = 'resolved-v' + lock.lockfileVersion;
        const packages = lock.packages;
        for (const [field] of fields) {
          for (const [name, spec] of Object.entries(manifest[field] || {})) {
            if (packages['']?.[field]?.[name] !== spec) addFinding(`manifest-lock-mismatch:${project.id}:${field}:${name}`, project.id, 'manifest-lock-mismatch', `${name} differs between package.json and lockfile root`, 'package.json + package-lock.json');
          }
        }
        const occurrence = (location) => `occ:${project.id}:${location}`;
        for (const [location, item] of Object.entries(packages)) {
          if (!location) continue;
          const name = item.name || pkgName(location);
          if (!name) continue;
          const version = item.version || 'unversioned';
          const oid = occurrence(location);
          const aid = `npm:${name}@${version}`;
          addNode({ id: oid, kind: 'occurrence', label: `${name}@${version}`, name, version, projectId: project.id, location, sourceKind: sourceKind(item.resolved), integrity: item.integrity || null, localDeprecation: item.deprecated || null });
          addNode({ id: aid, kind: 'artifact', label: `${name}@${version}`, name, version, ecosystem: 'npm', localDeprecation: item.deprecated || nodes.get(aid)?.localDeprecation || null });
          addEdge({ from: oid, to: aid, kind: 'resolves-to', source: 'package-lock.json' });
          const repo = gitHubRepo(item.resolved);
          if (repo) {
            const rid = `github:${repo.toLowerCase()}`;
            addNode({ id: rid, kind: 'repository', label: repo });
            addEdge({ from: oid, to: rid, kind: 'sourced-from', source: 'package-lock.json' });
          }
        }
        for (const [field, scope] of fields) {
          for (const [name, spec] of Object.entries(manifest[field] || {})) {
            const found = lookup(packages, '', name);
            if (found) {
              addEdge({ from: id, to: occurrence(found), kind: 'depends-on', scope, requested: spec, source: 'package.json + package-lock.json' });
              const declaration = rootDeclarations.get(`${scope}:${name}`);
              if (declaration) addEdge({ from: declaration, to: occurrence(found), kind: 'resolved-by', scope, source: 'package-lock.json' });
            }
            else if (scope !== 'peer' && scope !== 'optional') addFinding(`unresolved:${project.id}:${name}:${scope}`, project.id, 'unresolved-direct', `${name} is declared but not resolved in the npm lockfile`, 'package.json + package-lock.json');
          }
        }
        for (const [location, item] of Object.entries(packages)) {
          if (!location) continue;
          for (const [field, scope] of fields) {
            for (const [name, spec] of Object.entries(item[field] || {})) {
              const found = lookup(packages, location, name);
              if (found) addEdge({ from: occurrence(location), to: occurrence(found), kind: 'depends-on', scope, requested: spec, source: 'package-lock.json' });
              else if (scope === 'runtime') addFinding(`unresolved:${project.id}:${location}:${name}`, project.id, 'unresolved-transitive', `${name} is referenced but not resolved in the npm lockfile`, 'package-lock.json');
            }
          }
        }
      }
    }
    if (usePnpm) {
      try {
        const parsed = parsePnpmV9(pnpmSource.text);
        record.npm = 'pnpm-v9';
        const occurrence = (path) => `occ:${project.id}:pnpm:${path}`;
        const ensureWorkspace = (path) => {
          const wid = `workspace:${project.id}:${path}`;
          addNode({ id: wid, kind: 'workspace', label: path, projectId: project.id, location: path });
          return wid;
        };
        const splitKey = (key) => {
          const base = key.split('(')[0]; const at = base.lastIndexOf('@');
          return at > 0 ? [base.slice(0, at), base.slice(at + 1)] : [base, 'unversioned'];
        };
        for (const key of parsed.snapshots.keys()) {
          const [name, version] = splitKey(key), oid = occurrence(key), aid = `npm:${name}@${version}`;
          addNode({ id: oid, kind: 'occurrence', label: `${name}@${version}`, name, version, projectId: project.id, location: `pnpm:${key}`, sourceKind: 'pnpm-lock', integrity: null });
          addNode({ id: aid, kind: 'artifact', label: `${name}@${version}`, name, version, ecosystem: 'npm', localDeprecation: nodes.get(aid)?.localDeprecation || null });
          addEdge({ from: oid, to: aid, kind: 'resolves-to', source: 'pnpm-lock.yaml' });
        }
        let unresolved = 0;
        const link = (from, name, version, scope, requested, source) => {
          if (version.startsWith('link:')) {
            const target = ensureWorkspace(version.slice(5));
            addEdge({ from, to: target, kind: 'depends-on', scope, requested, source });
            return target;
          }
          const key = `${name}@${version}`;
          if (parsed.snapshots.has(key)) { addEdge({ from, to: occurrence(key), kind: 'depends-on', scope, requested, source }); return occurrence(key); }
          unresolved++;
          return null;
        };
        for (const [importer, groups] of parsed.importers) {
          const from = importer === '.' ? id : ensureWorkspace(importer);
          if (importer !== '.') addEdge({ from: id, to: from, kind: 'contains-workspace', source: 'pnpm-lock.yaml' });
          for (const [field, scope] of fields) for (const [name, entry] of Object.entries(groups[field] || {})) {
            const target = link(from, name, entry.version || '', scope, entry.specifier || null, 'pnpm-lock.yaml');
            let declaration = importer === '.' ? rootDeclarations.get(`${scope}:${name}`) : null;
            if (!declaration) {
              declaration = `decl:js:${project.id}:${importer}:${scope}:${name}`;
              addNode({ id: declaration, kind: 'declaration', label: `${name} ${entry.specifier || ''}`.trim(), name, requested: entry.specifier || null, ecosystem: 'JavaScript', projectId: project.id });
              addEdge({ from, to: declaration, kind: 'declares', scope, source: 'pnpm-lock.yaml importer' });
            }
            if (target) addEdge({ from: declaration, to: target, kind: 'resolved-by', scope, source: 'pnpm-lock.yaml' });
          }
        }
        for (const [key, groups] of parsed.snapshots) for (const [field, scope] of fields) for (const [name, version] of Object.entries(groups[field] || {})) link(occurrence(key), name, version, scope, null, 'pnpm-lock.yaml');
        if (unresolved) addFinding(`pnpm-unresolved:${project.id}`, project.id, 'partial-lockfile-graph', `${unresolved} pnpm references need a parser extension`, 'pnpm-lock.yaml', 'Unresolved references were omitted from graph edges; review aliases, file dependencies, or unsupported lock syntax.');
      } catch (error) {
        record.npm = 'pnpm-unsupported';
        addFinding(`pnpm-unsupported:${project.id}`, project.id, 'unsupported-lockfile', 'pnpm lockfile could not be resolved', 'pnpm-lock.yaml', error.message);
      }
    }
    const workflows = await readdir(resolve(root, '.github/workflows')).catch(() => []);
    let actionCount = 0;
    for (const workflow of workflows.filter(name => /\.ya?ml$/i.test(name))) {
      const source = await readSource(root, `.github/workflows/${workflow}`);
      if (source.state !== 'present') continue;
      for (const line of source.text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)(?:['"]|\s|$)/);
        if (!match) continue;
        const spec = match[1];
        const aid = `action:${spec}`;
        addNode({ id: aid, kind: 'action', label: spec, reference: spec.split('@').at(-1), pinned: /@[0-9a-f]{40}$/i.test(spec) });
        addEdge({ from: id, to: aid, kind: 'uses-action', source: `.github/workflows/${workflow}` });
        const repo = spec.match(/^([^/]+\/[^/@]+)/)?.[1];
        if (repo && !spec.startsWith('./') && !spec.startsWith('docker://')) {
          const rid = `github:${repo.toLowerCase()}`;
          addNode({ id: rid, kind: 'repository', label: repo });
          addEdge({ from: aid, to: rid, kind: 'sourced-from', source: `.github/workflows/${workflow}` });
        }
        actionCount++;
      }
    }
    if (workflows.length) record.actions = `${actionCount} workflow uses`;
    const requirements = await readSource(root, 'requirements.txt');
    if (requirements.state === 'present') {
      let count = 0;
      for (const line of requirements.text.split(/\r?\n/)) {
        const spec = line.trim().split('#')[0].trim();
        if (!spec || spec.startsWith('-')) continue;
        const match = spec.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(==|>=|<=|~=|>|<)?\s*([^;\s]+)?/);
        if (!match) continue;
        const [, name, operator, version] = match;
        const pinned = operator === '==' && !!version;
        const pid = pinned ? `pypi:${name.toLowerCase()}@${version}` : `decl:python:${project.id}:${name}`;
        addNode({ id: pid, kind: pinned ? 'artifact' : 'declaration', label: pinned ? `${name}@${version}` : `${name} ${spec.slice(name.length).trim()}`, name, version: pinned ? version : null, requested: spec, ecosystem: 'PyPI', projectId: project.id });
        addEdge({ from: id, to: pid, kind: pinned ? 'depends-on' : 'declares', scope: 'runtime', source: 'requirements.txt' });
        count++;
      }
      record.python = `${count} requirements`;
    } else if (requirements.state === 'error') {
      record.python = 'read-error';
      addFinding(`requirements:${project.id}`, project.id, 'requirements-error', 'Python requirements need attention', 'requirements.txt', requirements.reason);
    }
    const gitmodules = await readSource(root, '.gitmodules');
    if (gitmodules.state === 'present') {
      for (const match of gitmodules.text.matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
        const repo = gitHubRepo(match[1]);
        if (!repo) continue;
        const rid = `github:${repo.toLowerCase()}`;
        addNode({ id: rid, kind: 'repository', label: repo });
        addEdge({ from: id, to: rid, kind: 'submodule', source: '.gitmodules' });
      }
    }
    const head = includeGit ? git(root, 'rev-parse', 'HEAD') : null;
    if (head) {
      const branch = git(root, 'branch', '--show-current');
      const origin = git(root, 'config', '--get', 'remote.origin.url');
      const repo = gitHubRepo(origin);
      const upstream = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
      const counts = upstream ? git(root, 'rev-list', '--left-right', '--count', `HEAD...${upstream}`) : null;
      const parts = counts?.split(/\s+/).map(Number);
      const topLevel = git(root, 'rev-parse', '--show-toplevel');
      const repoRoot = topLevel ? resolve(topLevel) : null;
      const rootIsRepoSubdirectory = repoRoot ? relative(repoRoot, root) !== '' : false;
      const rid = `checkout:${project.id}`;
      addNode({ id: rid, kind: 'checkout', label: branch || head.slice(0, 12), projectId: project.id, commit: head, branch: branch || null, origin: repo || (origin ? 'other-remote' : null), upstream: upstream || null, ahead: parts?.[0] ?? null, behind: parts?.[1] ?? null, upstreamIsCached: true, repoRoot, rootIsRepoSubdirectory });
      addEdge({ from: id, to: rid, kind: 'checked-out-at', source: 'local-git' });
      if (repo) {
        const remoteId = `github:${repo.toLowerCase()}`;
        addNode({ id: remoteId, kind: 'repository', label: repo });
        addEdge({ from: rid, to: remoteId, kind: 'tracks', source: 'local-git' });
      }
      record.git = upstream ? 'cached-upstream' : 'local-head-only';
    }
    snapshot.coverage.push(record);
  }
  snapshot.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  snapshot.edges = [...edges.values()].sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`));
  snapshot.findings.sort((a, b) => a.id.localeCompare(b.id));
  return snapshot;
}

function diff(previous, current) {
  const events = [];
  const oldFindings = new Map(previous.findings.map(x => [x.id, x]));
  const newFindings = new Map(current.findings.map(x => [x.id, x]));
  for (const f of current.findings) if (!oldFindings.has(f.id)) events.push({ id: stable(`opened:${f.id}`), kind: 'finding-opened', finding: f });
  for (const f of previous.findings) if (!newFindings.has(f.id)) events.push({ id: stable(`resolved:${f.id}`), kind: 'finding-resolved', finding: f });
  const versions = (s) => new Map(s.nodes.filter(n => n.kind === 'occurrence').map(n => [`${n.projectId}|${n.location}`, n]));
  const before = versions(previous), after = versions(current);
  for (const [key, node] of after) {
    const old = before.get(key);
    if (!old) events.push({ id: stable(`added:${key}:${node.version}`), kind: 'package-added', projectId: node.projectId, name: node.name, version: node.version, evidence: node.location });
    else if (old.version !== node.version || old.integrity !== node.integrity || old.sourceKind !== node.sourceKind) events.push({ id: stable(`version:${key}:${old.version}:${node.version}:${node.integrity}`), kind: 'package-changed', projectId: node.projectId, name: node.name, from: old.version, to: node.version, evidence: node.location });
  }
  for (const [key, node] of before) if (!after.has(key)) events.push({ id: stable(`removed:${key}:${node.version}`), kind: 'package-removed', projectId: node.projectId, name: node.name, version: node.version, evidence: node.location });
  const checkouts = (s) => new Map(s.nodes.filter(n => n.kind === 'checkout').map(n => [n.projectId, n]));
  const oldGit = checkouts(previous);
  for (const [projectId, node] of checkouts(current)) {
    const old = oldGit.get(projectId);
    if (old && old.commit !== node.commit) events.push({ id: stable(`commit:${projectId}:${old.commit}:${node.commit}`), kind: 'checkout-changed', projectId, from: old.commit, to: node.commit, evidence: 'local-git' });
  }
  const currentNodes = new Map(current.nodes.map(node => [node.id, node]));
  const impacted = new Map();
  for (const edge of current.edges) if (edge.kind === 'resolves-to') {
    const projectId = currentNodes.get(edge.from)?.projectId;
    if (!projectId) continue;
    if (!impacted.has(edge.to)) impacted.set(edge.to, new Set());
    impacted.get(edge.to).add(projectId);
  }
  const previousArtifacts = new Map(previous.nodes.filter(node => node.kind === 'artifact').map(node => [node.id, node]));
  for (const artifact of current.nodes.filter(node => node.kind === 'artifact' && node.ecosystem === 'npm')) {
    const now = current.enrichment?.packages?.[artifact.id], old = previous.enrichment?.packages?.[artifact.id];
    const base = { artifactId: artifact.id, name: artifact.name, version: artifact.version, impactedProjects: [...(impacted.get(artifact.id) || [])].sort() };
    if (artifact.localDeprecation && artifact.localDeprecation !== previousArtifacts.get(artifact.id)?.localDeprecation && now?.registry?.status !== 'checked') events.push({ ...base, id: stable(`cached-deprecation:${artifact.id}:${artifact.localDeprecation}`), kind: 'cached-deprecation-observed', message: artifact.localDeprecation, source: 'package-lock.json', checkedAt: current.generatedAt });
    if (now?.osv?.status === 'checked') {
      const priorIds = old?.osv?.status === 'checked' ? new Set((old.osv.advisories || []).map(item => item.id)) : new Set();
      const currentIds = new Set((now.osv.advisories || []).map(item => item.id));
      for (const item of now.osv.advisories || []) if (!priorIds.has(item.id)) events.push({ ...base, id: stable(`advisory:${artifact.id}:${item.id}`), kind: 'advisory-observed', advisoryId: item.id, source: 'OSV', checkedAt: now.osv.checkedAt, baselineKnown: old?.osv?.status === 'checked' });
      if (old?.osv?.status === 'checked') for (const item of old.osv.advisories || []) if (!currentIds.has(item.id)) events.push({ ...base, id: stable(`advisory-no-longer-returned:${artifact.id}:${item.id}`), kind: 'advisory-no-longer-returned', advisoryId: item.id, source: 'OSV', checkedAt: now.osv.checkedAt });
    }
    if (now?.registry?.status === 'checked') {
      if (now.registry.deprecated && now.registry.deprecated !== old?.registry?.deprecated) events.push({ ...base, id: stable(`deprecated:${artifact.id}:${now.registry.deprecated}`), kind: 'deprecation-observed', message: now.registry.deprecated, source: 'npm registry', checkedAt: now.registry.checkedAt, baselineKnown: old?.registry?.status === 'checked' });
      if (now.registry.newerLatestTag && (!old?.registry?.newerLatestTag || old.registry.latestTag !== now.registry.latestTag)) events.push({ ...base, id: stable(`newer-latest:${artifact.id}:${now.registry.latestTag}`), kind: 'newer-latest-observed', latestTag: now.registry.latestTag, source: 'npm registry', checkedAt: now.registry.checkedAt, baselineKnown: old?.registry?.status === 'checked' });
    }
  }
  return { schemaVersion: 1, previousAt: previous.generatedAt, currentAt: current.generatedAt, events: events.sort((a, b) => a.id.localeCompare(b.id)) };
}

try {
  if (command === 'init' && option('out')) {
    const destination = option('out');
    if (destination !== '-' && await stat(resolve(destination)).catch(() => null)) throw new Error('Config already exists; choose a new output path');
    await output(destination, JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2) + '\n');
    console.error(`Created empty portfolio config in ${outputLabel(destination)}; add selected roots before scanning.`);
  }
  else if (command === 'discover' && options('search-root').length && option('out')) {
    const { discover, configuredProjects } = await import('./discover.mjs');
    const config = option('config') ? await json(option('config')) : { projects: [] };
    const result = await discover({ searchRoots: options('search-root'), projects: configuredProjects(config, option('config') || process.cwd()), maxDepth: option('depth') ? Number(option('depth')) : 3, maxDirectories: option('max-directories') ? Number(option('max-directories')) : 10000 });
    await output(option('out'), JSON.stringify(result, null, 2) + '\n');
    console.error(`Discovered ${result.candidates.length} source roots; ${result.candidates.filter(candidate => candidate.status === 'unlisted').length} unlisted, ${result.candidates.filter(candidate => candidate.status === 'nested-unscanned').length} nested. ${result.truncated ? 'Directory limit reached. ' : ''}${result.unreadableDirectories.length ? result.unreadableDirectories.length + ' unreadable directories. ' : ''}${result.incomplete ? 'Discovery is incomplete.' : ''}`);
  }
  else if (command === 'adopt-discovery' && option('config') && option('discovery') && option('out')) {
    const { adoptDiscovery } = await import('./discover.mjs');
    const result = adoptDiscovery(await json(option('config')), await json(option('discovery')), { nestedLocks: args.includes('--nested-locks'), configFile: option('config') });
    await output(option('out'), JSON.stringify(result.config, null, 2) + '\n');
    console.error(`Added ${result.added.length} roots to ${outputLabel(option('out'))}; inspect this private config before scanning.`);
  }
  else if (command === 'set-root' && option('config') && option('id') && option('root') && option('out')) {
    const { upsertRoot } = await import('./discover.mjs');
    const state = await stat(resolve(option('root'))).catch(() => null);
    if (!state?.isDirectory()) throw new Error('Root is not an accessible directory');
    const next = upsertRoot(await json(option('config')), { id: option('id'), label: option('label'), root: option('root') });
    await output(option('out'), JSON.stringify(next, null, 2) + '\n');
    console.error(`Saved ${option('id')} root to ${outputLabel(option('out'))}. Re-scan with this config to update coverage.`);
  }
  else if (command === 'scan' && option('config') && option('out')) await output(option('out'), JSON.stringify(await scan(option('config'), !args.includes('--no-git')), null, 2) + '\n');
  else if (command === 'enrich' && option('snapshot') && option('out')) {
    const { enrichSnapshot } = await import('./enrich.mjs');
    const enriched = await enrichSnapshot(await json(option('snapshot')), { projectId: option('project') });
    await output(option('out'), JSON.stringify(enriched, null, 2) + '\n');
    const entries = Object.values(enriched.enrichment.packages);
    console.error(`External lookups recorded: ${entries.filter(entry => entry.osv?.status === 'checked').length} OSV checks, ${entries.filter(entry => entry.registry?.status === 'checked').length} npm registry checks; failed or unavailable checks remain unknown.`);
  }
  else if (command === 'advisory-details' && option('snapshot') && option('out')) {
    const { addAdvisoryDetails } = await import('./advisory-details.mjs');
    const enriched = await addAdvisoryDetails(await json(option('snapshot')));
    await output(option('out'), JSON.stringify(enriched, null, 2) + '\n');
    const records = Object.values(enriched.enrichment.advisories);
    console.error(`OSV advisory details: ${records.filter(record => record.status === 'checked').length} checked, ${records.filter(record => record.status === 'error').length} failed.`);
  }
  else if (command === 'diff' && option('previous') && option('current') && option('out')) await output(option('out'), JSON.stringify(diff(await json(option('previous')), await json(option('current'))), null, 2) + '\n');
  else if (command === 'render' && option('snapshot') && option('out')) {
    await output(option('out'), await renderHtml(await json(option('snapshot'))));
  }
  else if (command === 'serve' && option('config') && option('snapshot') && option('out')) {
    if (option('out') === '-') throw new Error('serve requires an HTML file output path');
    const { createServer } = await import('node:http');
    const { randomBytes } = await import('node:crypto');
    const { upsertRoot } = await import('./discover.mjs');
    const configFile = resolve(option('config')), snapshotFile = resolve(option('snapshot')), htmlFile = resolve(option('out'));
    const stateFile = resolve(option('state') || resolve(dirname(snapshotFile), 'triage-state.json'));
    const readTriage = async () => {
      try { return JSON.parse(await readFile(stateFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, items: {} }; throw error; }
    };
    const port = option('port') ? Number(option('port')) : 8765;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
    const token = randomBytes(32).toString('hex');
    let busy = false, triageBusy = false, pickerBusy = false;
    const pickerPrompt = 'Choose a project folder for Supply Chain Graph';
    const pickerCommand = () => {
      const custom = process.env.SUPPLY_CHAIN_FOLDER_PICKER?.trim();
      if (custom) return custom.startsWith('[') ? JSON.parse(custom) : custom.split(/\s+/);
      if (process.platform === 'win32') {
        const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '${pickerPrompt}'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }`;
        return ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      }
      if (process.platform === 'darwin') return ['osascript', '-e', `POSIX path of (choose folder with prompt "${pickerPrompt}")`];
      return ['zenity', '--file-selection', '--directory', `--title=${pickerPrompt}`];
    };
    const pickFolder = () => new Promise((done, reject) => {
      const [command, ...argv] = pickerCommand();
      let out = '', err = '';
      const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10 * 60 * 1000 });
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.once('error', error => reject(new Error(error.code === 'ENOENT' ? `No folder dialog is available on this machine (${command} was not found). Paste the absolute path instead.` : error.message)));
      child.once('close', code => {
        const chosen = out.trim();
        if (chosen) return done(chosen);
        if (code === 0 || code === 1 || code === null || /cancel/i.test(err)) return done(null);
        reject(new Error(`The folder dialog exited with code ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ''}`));
      });
    });
    const server = createServer(async (request, response) => {
      const send = (status, body, type = 'application/json; charset=utf-8') => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(body); };
      const host = request.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, JSON.stringify({ error: 'Local host only' }));
      const requestUrl = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && requestUrl.pathname === '/') {
        if (requestUrl.searchParams.get('key') !== token) return send(403, JSON.stringify({ error: 'Use the session link printed by the server' }));
        try {
          const html = await readFile(htmlFile, 'utf8');
          return send(200, html.replace('<script>const snapshot =', `<script>window.supplyChainLocal = { token: '${token}' }; const snapshot =`), 'text/html; charset=utf-8');
        } catch { return send(404, JSON.stringify({ error: 'Dashboard has not been rendered' })); }
      }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return send(403, JSON.stringify({ error: 'Wrong origin' }));
      if (request.headers['x-supply-chain-token'] !== token) return send(403, JSON.stringify({ error: 'Invalid local request' }));
      if (request.method === 'GET' && requestUrl.pathname === '/api/triage') {
        try { return send(200, JSON.stringify(await readTriage())); }
        catch (error) { return send(500, JSON.stringify({ error: error.message })); }
      }
      if (request.method !== 'POST' || !['/api/set-root', '/api/triage', '/api/open-folder', '/api/pick-folder'].includes(requestUrl.pathname)) return send(404, JSON.stringify({ error: 'Not found' }));
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, JSON.stringify({ error: 'JSON required' }));
      if (requestUrl.pathname === '/api/pick-folder') {
        if (pickerBusy) return send(409, JSON.stringify({ error: 'A folder dialog is already open on this machine' }));
        pickerBusy = true;
        try {
          let body = '';
          for await (const chunk of request) { body += chunk; if (body.length > 2048) throw new Error('Request is too large'); }
          const chosen = await pickFolder();
          if (!chosen) return send(200, JSON.stringify({ cancelled: true }));
          const folder = await realpath(resolve(chosen)).catch(() => null);
          if (!folder || !(await stat(folder).catch(() => null))?.isDirectory()) throw new Error('The chosen path is not an accessible directory');
          if (folder === parse(folder).root) throw new Error('Choose a project folder, not a whole drive or filesystem root');
          const name = folder.split(/[\\/]/).filter(Boolean).at(-1) || '';
          const suggestedId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '') || 'project';
          return send(200, JSON.stringify({ path: folder, suggestedId, suggestedLabel: name }));
        } catch (error) { return send(400, JSON.stringify({ error: error.message })); }
        finally { pickerBusy = false; }
      }
      if (requestUrl.pathname === '/api/open-folder') {
        try {
          let body = '';
          for await (const chunk of request) { body += chunk; if (body.length > 2048) throw new Error('Request is too large'); }
          const { nodeId } = JSON.parse(body);
          if (typeof nodeId !== 'string' || nodeId.length > 500) throw new Error('Invalid node');
          const current = await json(snapshotFile);
          const node = current.nodes.find(item => item.id === nodeId);
          if (!node?.projectId) throw new Error('Select a node tied to a local project');
          const config = await json(configFile);
          const configured = config.projects.find(item => item.id === node.projectId);
          if (!configured?.root) throw new Error('Set the project root first');
          const root = await realpath(resolve(dirname(configFile), configured.root));
          if (!(await stat(root)).isDirectory()) throw new Error('Project root is not a directory');
          let folder = root;
          if (node.kind === 'occurrence' && typeof node.location === 'string' && /^node_modules\//.test(node.location) && !node.location.split('/').includes('..')) {
            const candidate = resolve(root, node.location);
            const within = relative(root, candidate);
            if (within && !within.startsWith('..') && !isAbsolute(within)) {
              const actual = await realpath(candidate).catch(() => null);
              if (actual) {
                const inside = relative(root, actual);
                if (inside && !inside.startsWith('..') && !isAbsolute(inside) && (await stat(actual)).isDirectory()) folder = actual;
              }
            }
          }
          if (node.kind === 'source-file' && typeof node.location === 'string' && !node.location.split('/').includes('..')) {
            const candidate = resolve(root, node.location);
            const within = relative(root, candidate);
            if (within && !within.startsWith('..') && !isAbsolute(within)) {
              const actual = await realpath(candidate).catch(() => null);
              if (actual) {
                const inside = relative(root, actual);
                if (inside && !inside.startsWith('..') && !isAbsolute(inside) && (await stat(actual)).isFile()) folder = dirname(actual);
              }
            }
          }
          const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          await new Promise((done, reject) => {
            const child = spawn(opener, [folder], { detached: true, stdio: 'ignore', windowsHide: false });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); done(); });
          });
          return send(200, JSON.stringify({ opened: folder }));
        } catch (error) { return send(400, JSON.stringify({ error: error.message })); }
      }
      if (requestUrl.pathname === '/api/triage') {
        if (triageBusy) return send(409, JSON.stringify({ error: 'Triage save in progress' }));
        triageBusy = true;
        try {
          let body = '';
          for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error('Request is too large'); }
          const { key, status, note } = JSON.parse(body);
          if (typeof key !== 'string' || !/^(package|finding):.{1,300}$/.test(key)) throw new Error('Invalid action key');
          if (!['open', 'investigating', 'acknowledged'].includes(status)) throw new Error('Invalid action status');
          if (typeof note !== 'string' || note.length > 1000) throw new Error('Note must be at most 1000 characters');
          const state = await readTriage();
          state.items[key] = { status, note, updatedAt: new Date().toISOString() };
          await output(stateFile, JSON.stringify(state, null, 2) + '\n');
          return send(200, JSON.stringify(state.items[key]));
        } catch (error) { return send(400, JSON.stringify({ error: error.message })); }
        finally { triageBusy = false; }
      }
      if (busy) return send(409, JSON.stringify({ error: 'A scan is already running' }));
      busy = true;
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error('Request is too large'); }
        const { id, label, root } = JSON.parse(body);
        const state = await stat(resolve(root)).catch(() => null);
        if (!state?.isDirectory()) throw new Error('Choose an accessible directory');
        const config = upsertRoot(await json(configFile), { id, label, root });
        const prior = await json(snapshotFile).catch(() => null);
        await output(configFile, JSON.stringify(config, null, 2) + '\n');
        const next = await scan(configFile);
        if (prior?.enrichment?.packages) {
          const ids = new Set(next.nodes.filter(node => node.kind === 'artifact').map(node => node.id));
          next.enrichment = { ...prior.enrichment, packages: Object.fromEntries(Object.entries(prior.enrichment.packages).filter(([id]) => ids.has(id))) };
        }
        await output(snapshotFile, JSON.stringify(next, null, 2) + '\n');
        await output(htmlFile, await renderHtml(next));
        return send(200, JSON.stringify({ ok: true, projects: config.projects.length, scannedAt: next.generatedAt }));
      } catch (error) { return send(400, JSON.stringify({ error: error.message })); }
      finally { busy = false; }
    });
    await new Promise((done, reject) => server.once('error', reject).listen(port, '127.0.0.1', done));
    console.error(`Local dashboard editing mode: http://127.0.0.1:${port}/?key=${token}`);
  }
  else help();
} catch (error) { console.error(error.message); process.exitCode = 1; }
