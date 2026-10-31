// Small JSON Schema validator for the contracts in contracts/*.schema.json.
// It covers the subset those schemas use (type, properties, required, additionalProperties, items, enum, const,
// pattern, min/max, anyOf/oneOf/allOf, $ref to #/$defs) so the CLI stays dependency-free. It is not a general validator.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../contracts');
export const schemaNames = ['snapshot', 'diff-events', 'policy', 'policy-result', 'agent-packet', 'proposal', 'decision'];

export async function loadSchema(name) {
  if (!schemaNames.includes(name)) throw new Error(`Unknown schema "${name}". Known schemas: ${schemaNames.join(', ')}`);
  return JSON.parse(await readFile(resolve(contractsDir, `${name}.v1.schema.json`), 'utf8'));
}

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const matchesType = (value, type) => type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeOf(value) === type;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref values are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root) ?? (() => { throw new Error(`Unresolved $ref: ${ref}`); })();
}

function check(schema, value, path, root, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push({ path, message: 'value is not allowed here' }); return; }
  if (schema.$ref) { check(resolveRef(schema.$ref, root), value, path, root, errors); return; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) { errors.push({ path, message: `expected ${types.join(' or ')}, got ${typeOf(value)}` }); return; }
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) errors.push({ path, message: `expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}` });
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: `does not match ${schema.pattern}` });
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path, message: `shorter than ${schema.minLength}` });
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push({ path, message: `longer than ${schema.maxLength}` });
    if (schema.format === 'date-time' && !dateTime.test(value)) errors.push({ path, message: 'expected an ISO 8601 date-time' });
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, message: `below minimum ${schema.minimum}` });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, message: `above maximum ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push({ path, message: `fewer than ${schema.minItems} items` });
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, message: `more than ${schema.maxItems} items` });
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${path}/${index}`, root, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push({ path, message: `missing required property "${key}"` });
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) check(child, value[key], `${path}/${key}`, root, errors);
    if (schema.additionalProperties === false || (schema.additionalProperties && typeof schema.additionalProperties === 'object')) {
      for (const key of Object.keys(value)) {
        if (schema.properties && key in schema.properties) continue;
        if (schema.additionalProperties === false) errors.push({ path: `${path}/${key}`, message: 'unexpected property' });
        else check(schema.additionalProperties, value[key], `${path}/${key}`, root, errors);
      }
    }
    if (schema.propertyNames?.pattern) for (const key of Object.keys(value)) if (!new RegExp(schema.propertyNames.pattern).test(key)) errors.push({ path: `${path}/${key}`, message: `property name does not match ${schema.propertyNames.pattern}` });
  }
  if (schema.allOf) for (const branch of schema.allOf) check(branch, value, path, root, errors);
  if (schema.anyOf) {
    const passes = schema.anyOf.some(branch => { const inner = []; check(branch, value, path, root, inner); return inner.length === 0; });
    if (!passes) errors.push({ path, message: 'does not match any allowed form' });
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(branch => { const inner = []; check(branch, value, path, root, inner); return inner.length === 0; }).length;
    if (passing !== 1) errors.push({ path, message: passing ? 'matches more than one exclusive form' : 'does not match any allowed form' });
  }
}

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', schema, errors);
  return { valid: errors.length === 0, errors: errors.map(error => ({ path: error.path || '/', message: error.message })) };
}

// Major schema versions are explicit: a document whose schemaVersion is not the supported major is rejected before field validation,
// so an unsupported newer format is never silently reinterpreted as the current one.
export function assertSupportedVersion(document, supportedMajor = 1, label = 'document') {
  const version = document?.schemaVersion;
  if (!Number.isInteger(version) || version < 1) throw new Error(`${label} has no integer schemaVersion`);
  if (version !== supportedMajor) throw new Error(`${label} schemaVersion ${version} is not supported by this tool (supports ${supportedMajor})`);
}

export async function validateNamed(name, value) {
  const schema = await loadSchema(name);
  return validate(schema, value);
}
