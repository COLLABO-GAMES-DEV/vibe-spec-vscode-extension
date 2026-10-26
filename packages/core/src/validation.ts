import { pathFromParts, appendPath } from './paths.js';
import { resourceEntry, resourceFile } from './resources.js';
import { documentDiagnostics } from './documents.js';
import { Ajv } from 'ajv';
import { Decimal } from 'decimal.js';
import { isScalar } from 'yaml';
import { isRecord, validName, VibeError } from './types.js';
import { resourceNameError, suggestResourceName } from './names.js';
import type { Column, Diagnostic, Project, Table, TableSchema, YamlFile } from './types.js';
import { validatePlans } from './plans.js';

const ajv = new Ajv({ allErrors: true, ownProperties: true });
const checkSchema = ajv.compile<TableSchema>({
  type: 'object', required: ['primary_key', 'columns'], additionalProperties: false,
  properties: {
    primary_key: { type: 'string', minLength: 1, pattern: '^[^/]+$' },
    columns: {
      type: 'object', minProperties: 1, additionalProperties: false,
      patternProperties: {
        '^[^/]+$': {
          type: 'object', required: ['type'], additionalProperties: false,
          properties: {
            type: { enum: ['string', 'text', 'integer', 'decimal', 'boolean', 'enum', 'ref'] },
            label: { type: 'string' },
            required: { type: 'boolean' }, nullable: { type: 'boolean' },
            values: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
            minimum: { type: 'string' }, maximum: { type: 'string' },
            table: { type: 'string', minLength: 1, pattern: '^[^/]+$' },
            on_delete: { const: 'restrict' },
          },
        },
      },
    },
    unique: {
      type: 'array', uniqueItems: true,
      items: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    },
  },
});
const checkTable = ajv.compile<Table>({
  type: 'object', required: ['schema', 'rows'], additionalProperties: false,
  properties: {
    schema: { type: 'string', minLength: 1, pattern: '^[^/]+$' },
    rows: { type: 'array', items: { type: 'object' } },
  },
});
const decimalSyntax = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const zeroSyntax = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/;

function decimal(value: string): Decimal {
  if (!decimalSyntax.test(value)) throw new Error('Expected a decimal string.');
  const result = new Decimal(value);
  // Reject library overflow/underflow as an inability to compare, never rewrite the source.
  if (!result.isFinite() || result.isZero() && !zeroSyntax.test(value)) {
    throw new Error('The decimal library cannot represent this value for comparison.');
  }
  return result;
}

function issue(code: string, file: string, path: string, message: string): Diagnostic {
  return { code, file, path, message };
}

export function schemaDiagnostics(file: YamlFile): Diagnostic[] {
  const errors: Diagnostic[] = [];
  // Resource declarations use filename rules; column codes, labels and Key values do not.
  if (isRecord(file.data) && isRecord(file.data.columns)) {
    for (const [name, column] of Object.entries(file.data.columns)) {
      if (!isRecord(column) || typeof column.table !== 'string') continue;
      const error = resourceNameError(column.table);
      if (error) errors.push(issue('NAME_INVALID', file.file, 'columns/' + name + '/table',
        error + ' 이름 제안: ' + suggestResourceName(column.table)));
    }
  }
  if (!checkSchema(file.data)) return [...errors, ...checkSchema.errors!.map(error =>
    issue('SCHEMA_SHAPE', file.file, error.instancePath, error.message ?? 'Invalid schema.'))];
  const schema = file.data;
  const fail = (path: string, message: string) =>
    errors.push(issue('SCHEMA_RULE', file.file, path, message));
  const primary = schema.columns[schema.primary_key];
  if (!primary || !['string', 'text', 'integer'].includes(primary.type) ||
      primary.nullable === true || primary.required === false) {
    fail(schema.primary_key, 'The primary key must name one required, non-null string/text/integer column.');
  }
  for (const [name, column] of Object.entries(schema.columns)) {
    if (column.type === 'enum' ? !column.values : column.values !== undefined) {
      fail(name, 'values is required only for enum columns.');
    }
    if (column.type === 'ref' ? !column.table : column.table !== undefined || column.on_delete !== undefined) {
      fail(name, 'table and on_delete belong to ref columns; ref requires a target table.');
    }
    if (column.minimum !== undefined || column.maximum !== undefined) {
      if (!['integer', 'decimal'].includes(column.type)) fail(name, 'Bounds require a numeric column.');
      try {
        const min = column.minimum === undefined ? undefined : decimal(column.minimum);
        const max = column.maximum === undefined ? undefined : decimal(column.maximum);
        if (min && max && min.gt(max)) fail(name, 'minimum exceeds maximum.');
      } catch (error) {
        fail(name, (error as Error).message);
      }
    }
  }
  for (const fields of schema.unique ?? []) {
    if (fields.some(field => !Object.hasOwn(schema.columns, field))) {
      fail('unique', 'A unique constraint refers to an unknown column.');
    }
  }
  return errors;
}

interface TableContext {
  file: YamlFile;
  table: Table;
  schema: TableSchema;
}

export function tableContexts(project: Project): Map<string, TableContext> {
  const result = new Map<string, TableContext>();
  for (const [path, file] of project.files) {
    if (!path.startsWith('tables/') || !checkTable(file.data)) continue;
    if (resourceFile(project, 'table', resourceEntry(path)!.name) !== path) continue;
    const schemaFile = project.files.get(resourceFile(project, 'schema', file.data.schema) ?? '');
    // Legacy resource names remain readable so rename can repair their declarations.
    if (schemaFile && !schemaDiagnostics(schemaFile).some(error => error.code !== 'NAME_INVALID')) {
      result.set(resourceEntry(path)!.name, { file, table: file.data, schema: schemaFile.data as TableSchema });
    }
  }
  return result;
}

// A broken, unrelated schema rule must not switch off a declared relationship.
export function declaredReferences(project: Project) {
  const references: {
    file: YamlFile; name: string; table: Table; primaryKey: string;
    field: string; target: string; restrict: boolean;
  }[] = [];
  for (const [path, file] of project.files) {
    if (!path.startsWith('tables/') || !checkTable(file.data)) continue;
    const schema = project.files.get(resourceFile(project, 'schema', file.data.schema) ?? '')?.data;
    if (!isRecord(schema) || !isRecord(schema.columns)) continue;
    for (const [field, column] of Object.entries(schema.columns)) {
      if (!isRecord(column) || column.type !== 'ref' || typeof column.table !== 'string' || !validName(column.table)) continue;
      references.push({
        file, name: resourceEntry(path)!.name, table: file.data,
        primaryKey: typeof schema.primary_key === 'string' ? schema.primary_key : '',
        field, target: column.table, restrict: column.on_delete === 'restrict',
      });
    }
  }
  return references;
}

function checkValue(value: unknown, column: Column): string | undefined {
  if (value === null) return column.nullable ? undefined : 'null is not allowed.';
  if (column.type === 'boolean') return typeof value === 'boolean' ? undefined : 'Expected a boolean.';
  if (typeof value !== 'string') return 'Expected a string; numbers must retain their source text.';
  if (column.type === 'enum' && !column.values!.includes(value)) return 'Value is not in the enum.';
  if (column.type === 'integer' && !/^[+-]?\d+$/.test(value)) return 'Expected an integer string.';
  if (column.type === 'integer' || column.type === 'decimal') {
    try {
      const number = decimal(value);
      if (column.minimum !== undefined && number.lt(decimal(column.minimum))) return 'Value is below minimum.';
      if (column.maximum !== undefined && number.gt(decimal(column.maximum))) return 'Value is above maximum.';
    } catch (error) {
      return (error as Error).message;
    }
  }
  return undefined;
}

function uniqueValue(value: unknown, column: Column): unknown {
  if (column.type === 'integer' || column.type === 'decimal') {
    return ['number', decimal(value as string).toString()];
  }
  return [typeof value, value];
}

export function validateProject(project: Project): Diagnostic[] {
  return [...validateBaseline(project), ...validatePlans(project, validateBaseline)];
}

export function validateBaseline(project: Project): Diagnostic[] {
  const errors = [...project.diagnostics.filter(item => !item.file.startsWith('plans/')), ...documentDiagnostics(project)];
  for (const [path, file] of project.files) {
    if (path.startsWith('schemas/')) errors.push(...schemaDiagnostics(file));
    if (path.startsWith('tables/')) {
      if (isRecord(file.data) && typeof file.data.schema === 'string') {
        const error = resourceNameError(file.data.schema);
        if (error) errors.push(issue('NAME_INVALID', path, 'schema',
          error + ' 이름 제안: ' + suggestResourceName(file.data.schema)));
      }
      if (!checkTable(file.data)) {
        errors.push(...checkTable.errors!.map(error =>
          issue('TABLE_SHAPE', path, error.instancePath, error.message ?? 'Invalid table.')));
      } else if (!resourceFile(project, 'schema', file.data.schema)) {
        errors.push(issue('SCHEMA_MISSING', path, '', 'Unknown schema: ' + file.data.schema));
      }
    }
  }
  const tables = tableContexts(project);
  const targetKeys = new Map([...tables].map(([name, context]) =>
    [name, new Set(context.table.rows.map(row => row[context.schema.primary_key]))]));
  for (const [name, { file, table, schema }] of tables) {
    const seenKeys = new Set<string>();
    for (const [index, row] of table.rows.entries()) {
      const key = row[schema.primary_key];
      const path = typeof key === 'string' && key.length ? pathFromParts([name, key]) : name;
      if (typeof key !== 'string' || !key.length || key === '*') {
        errors.push(issue('KEY_REQUIRED', file.file, path, 'Row ' + (index + 1) + ' needs a nonempty Key without reserved *.'));
      } else if (seenKeys.has(key)) {
        errors.push(issue('KEY_DUPLICATE', file.file, path, 'Duplicate primary Key.'));
      } else seenKeys.add(key);
      for (const field of Object.keys(row)) {
        if (!Object.hasOwn(schema.columns, field)) {
          errors.push(issue('COLUMN_UNKNOWN', file.file, appendPath(path, field), 'Column is not declared.'));
        }
      }
      for (const [field, column] of Object.entries(schema.columns)) {
        const location = appendPath(path, field);
        if (!Object.hasOwn(row, field)) {
          if (column.required && field !== schema.primary_key) {
            errors.push(issue('VALUE_REQUIRED', file.file, location, 'Required value is missing.'));
          }
          continue;
        }
        const value = row[field];
        const valueError = checkValue(value, column);
        if (valueError) {
          errors.push(issue('VALUE_TYPE_OR_RANGE', file.file, location, valueError));
          continue;
        }
        const node = file.document.getIn(['rows', index, field], true);
        if (typeof value === 'string' && isScalar(node) &&
            (node.type !== 'QUOTE_DOUBLE' && node.type !== 'QUOTE_SINGLE' ||
             node.range && /[\r\n]/.test(file.source.slice(node.range[0], node.range[1])))) {
          errors.push(issue('STRING_STYLE', file.file, location, 'Cell strings must be quoted on one physical line; use fmt.'));
        }
        if (column.type === 'ref' && value !== null) {
          if (typeof value !== 'string' || !value.length || value === '*' ||
              !targetKeys.get(column.table!)?.has(value)) {
            errors.push(issue('REF_MISSING', file.file, location,
              'Expected a Key in ' + column.table + ', not a full path.'));
          }
        }
      }
    }
    // Target-table declarations must be valid even when the source table is empty.
    for (const [field, column] of Object.entries(schema.columns)) {
      if (column.type === 'ref' && !tables.has(column.table!)) {
        errors.push(issue('REF_TABLE_MISSING', file.file, name + '/*/' + field, 'Unknown target table: ' + column.table));
      }
    }
    for (const fields of schema.unique ?? []) {
      const seen = new Set<string>();
      for (const row of table.rows) {
        if (fields.some(field => row[field] == null || checkValue(row[field], schema.columns[field]!))) continue;
        const token = JSON.stringify(fields.map(field => uniqueValue(row[field], schema.columns[field]!)));
        if (seen.has(token)) {
          errors.push(issue('UNIQUE_VIOLATION', file.file, pathFromParts([name, String(row[schema.primary_key])]),
            'Duplicate values for ' + fields.join(', ')));
        }
        seen.add(token);
      }
    }
  }
  return errors;
}

// Shared by edit/apply: inspect declarations even if an unrelated schema rule is invalid.
export function deletionDiagnostics(project: Project, table: string, key: string): Diagnostic[] {
  const contexts = tableContexts(project);
  const target = contexts.get(table);
  if (!target || target.table.rows.filter(row => row[target.schema.primary_key] === key).length !== 1) {
    throw new VibeError('PATH_NOT_FOUND', 'Deletion target is missing or ambiguous.');
  }
  const errors: Diagnostic[] = [];
  for (const reference of declaredReferences(project)) {
      const { name, field, primaryKey } = reference;
      if (reference.target !== table || !reference.restrict) continue;
      for (const row of reference.table.rows) {
        // References removed with the target row do not survive the deletion.
        if (name === table && row[primaryKey] === key) continue;
        if (row[field] === key) errors.push(issue('DELETE_RESTRICTED', reference.file.file,
          pathFromParts([name, String(row[primaryKey] ?? ''), field]),
          'This declared reference prevents deletion of ' + table + '/' + key));
      }
  }
  return errors;
}
