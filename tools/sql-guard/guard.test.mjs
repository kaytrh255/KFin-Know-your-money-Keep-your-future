import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeProject,
  analyzeSource,
  EXEMPTIONS,
} from './guard.mjs';

/**
 * The guard is a security control, so it is tested at two levels: a focused
 * fixture for every accepted and rejected SQL-text shape, and a run over the
 * real `packages/database/src`. The fixtures below are the mutation checks in
 * miniature — each "rejects" case is a statement that would be reachable from a
 * caller if the guard did not fire.
 */

const check = (code, options = {}) => analyzeSource(code, { filename: 'fixture.ts', ...options });

const PREFIX = "import type { Pool } from 'pg';\ndeclare const client: Pool;\n";
const source = (body) => PREFIX + body;

// ── accepted forms ───────────────────────────────────────────────────────────

test('accepts a string literal and a template without substitutions', () => {
  const result = check(source(`
    export async function run(): Promise<void> {
      await client.query('SELECT 1');
      await client.query(\`SELECT 2\`);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts placeholder indices derived from a parameter array length', () => {
  const result = check(source(`
    export async function run(values: unknown[]): Promise<void> {
      await client.query(\`SELECT * FROM t WHERE a = $\${values.length}\`, values);
      await client.query(\`SELECT * FROM t WHERE a = $\${values.length - 1} AND b = $\${values.length}\`, values);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a module-level column list and a local binding built from literals', () => {
  const result = check(source(`
    const COLUMNS = \`id, amount_minor\`;
    export async function run(): Promise<void> {
      const where = \`WHERE user_id = $1\`;
      await client.query(\`SELECT \${COLUMNS} FROM t \${where}\`, ['u']);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts filter arrays whose every element is a literal or a placeholder', () => {
  const result = check(source(`
    export async function run(values: unknown[], category?: string): Promise<void> {
      const filters: string[] = ['t.user_id = $1'];
      if (category) {
        values.push(category);
        filters.push(\`t.category = $\${values.length}\`);
      }
      await client.query(\`SELECT * FROM t WHERE \${filters.join(' AND ')}\`, values);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a let that is only ever assigned safe fragments', () => {
  const result = check(source(`
    export async function run(values: unknown[], cursor?: string): Promise<void> {
      let clause = '';
      if (cursor) {
        values.push(cursor, cursor);
        clause = \`AND (a, b) > ($\${values.length - 1}, $\${values.length})\`;
      }
      await client.query(\`SELECT 1 FROM t WHERE x = 1 \${clause}\`, values);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a conditional whose branches are both safe', () => {
  const result = check(source(`
    export async function run(values: unknown[]): Promise<void> {
      const filters: string[] = [];
      filters.push('t.user_id = $1');
      await client.query(\`SELECT 1 FROM t \${filters.length === 0 ? '' : \`WHERE \${filters.join(' AND ')}\`}\`, values);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a numeric interpolation (a number carries no SQL text)', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      await client.query(\`SELECT \${input.length}\`);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a wrapper that forwards its parameter and checks its call sites', () => {
  const result = check(source(`
    const query = (text: string, values: unknown[] = []) => client.query(text, [...values]);
    export async function run(): Promise<void> {
      await query('BEGIN');
      await query(\`SELECT 1 WHERE a = $\${1}\`, [1]);
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a chain of passthrough helpers with safe call sites', () => {
  const result = check(source(`
    function base(text: string, values: unknown[] = []) { return client.query(text, values); }
    const wrapped = (text: string, values: unknown[] = []) => base(text, values);
    export async function run(): Promise<void> {
      await wrapped('SELECT 1');
    }
  `));
  assert.deepEqual(result.violations, []);
});

test('accepts a method named query that forwards to a helper', () => {
  const result = check(source(`
    declare function base(client: Pool, text: string, values: unknown[]): Promise<unknown>;
    class Transaction {
      constructor(private readonly client: Pool) {}
      async query(text: string, values: unknown[] = []) { return base(this.client, text, values); }
    }
    export async function run(tx: Transaction): Promise<void> {
      await tx.query('SELECT 1');
    }
  `));
  assert.deepEqual(result.violations, []);
});

// ── rejected forms ───────────────────────────────────────────────────────────

test('rejects string concatenation with a runtime value', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      await client.query('SELECT * FROM t WHERE a = ' + input);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /concatenation/);
});

test('rejects a template that interpolates a function parameter', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      await client.query(\`SELECT * FROM t WHERE a = '\${input}'\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /not a local literal|cannot be resolved/i);
});

test('rejects a member expression such as req.body.sql', () => {
  const result = check(source(`
    export async function run(request: { body: { sql: string } }): Promise<void> {
      await client.query(request.body.sql);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /member access/);
});

test('rejects a helper call such as sql.raw()', () => {
  const result = check(source(`
    declare const sql: { raw: (value: string) => string };
    export async function run(input: string): Promise<void> {
      await client.query(sql.raw(input));
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /function call/);
});

test('rejects an unsafe argument passed to a passthrough wrapper', () => {
  const result = check(source(`
    const query = (text: string, values: unknown[] = []) => client.query(text, values);
    export async function run(input: string): Promise<void> {
      await query(\`SELECT * FROM t WHERE a = '\${input}'\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /passthrough `query`/);
});

test('rejects an unsafe call through an aliased query function', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      const execute = client.query;
      await execute(\`SELECT * FROM t WHERE a = '\${input}'\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /SQL statement/);
});

test('rejects an unsafe call through a destructured query function', () => {
  const result = check(source(`
    export async function run(client: { query: (text: string) => Promise<unknown> }, input: string): Promise<void> {
      const { query } = client;
      await query(\`SELECT * FROM t WHERE a = '\${input}'\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /SQL statement/);
});

test('checks the statement argument of .query.call()', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      await client.query.call(client, \`SELECT * FROM t WHERE a = '\${input}'\`);
    }
  `));
  assert.equal(result.violations.length, 1);
});

test('reports .query.apply() instead of guessing at its argument array', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      await client.query.apply(client, [\`SELECT * FROM t WHERE a = '\${input}'\`]);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /apply/);
});

test('rejects an array element that is unsafe, even when the join itself looks safe', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      const filters: string[] = [];
      filters.push(\`t.a = '\${input}'\`);
      await client.query(\`SELECT 1 FROM t WHERE \${filters.join(' AND ')}\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /push/);
});

test('rejects a let that is reassigned from runtime text', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      let clause = '';
      clause = input;
      await client.query(\`SELECT 1 FROM t WHERE x = 1 \${clause}\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /reassigned from/);
});

test('rejects a compound assignment on a fragment', () => {
  const result = check(source(`
    export async function run(input: string): Promise<void> {
      let clause = '';
      clause += input;
      await client.query(\`SELECT 1 FROM t WHERE x = 1 \${clause}\`);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /changed with/);
});

test('rejects a SQL call with no statement argument', () => {
  const result = check(source(`
    export async function run(): Promise<void> {
      await client.query();
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /without a statement argument/);
});

test('rejects an exported passthrough, whose callers cannot be checked', () => {
  const result = check(source(`
    export const query = (text: string, values: unknown[] = []) => client.query(text, values);
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /exported/);
});

test('aborts on a file that cannot be parsed instead of skipping it', () => {
  assert.throws(() => check('const broken = ;\n'));
});

// ── exemptions ───────────────────────────────────────────────────────────────

const MIGRATION_EXEMPTION = Object.freeze([Object.freeze({
  file: 'migrations.ts',
  function: 'applyMigration',
  argument: 'migration.sql',
  reason: 'fixture',
})]);

test('accepts the reviewed migration exemption only in its named function', () => {
  const allowed = check(`
    export async function applyMigration(client: { query: (text: string) => Promise<unknown> }, migration: { sql: string }) {
      await client.query(migration.sql);
    }
  `, { filename: 'migrations.ts', exemptions: MIGRATION_EXEMPTION });
  assert.deepEqual(allowed.violations, []);

  const rejected = check(`
    export async function elsewhere(client: { query: (text: string) => Promise<unknown> }, migration: { sql: string }) {
      await client.query(migration.sql);
    }
  `, { exemptions: MIGRATION_EXEMPTION });
  assert.equal(rejected.violations.length, 1);
  assert.match(rejected.violations[0].message, /member access/);
});

test('reports a stale exemption that no longer matches a call site', () => {
  const result = analyzeProject('packages/database/src', { exemptions: [
    ...EXEMPTIONS,
    { file: 'packages/database/src/migrations.ts', function: 'applyMigration', argument: 'gone.sql', reason: 'stale fixture' },
  ] });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /stale exemption/);
});

// ── the real layer ───────────────────────────────────────────────────────────

test('the database layer passes the guard and is actually scanned', () => {
  const result = analyzeProject();
  assert.deepEqual(result.violations, []);
  assert.ok(result.stats.files >= 10, `expected the whole layer, scanned ${result.stats.files} files`);
  assert.ok(result.stats.calls >= 100, `expected every execution site, saw ${result.stats.calls}`);
  // The control must have seen each accepted shape, otherwise it is passing
  // because it stopped modelling something rather than because the code is safe.
  for (const shape of ['literal', 'template', 'binding', 'passthrough-definition', 'exempted']) {
    assert.ok(result.stats[shape] > 0, `expected at least one ${shape} execution site`);
  }
});

test('a copy of the production filter pattern with an injected value is rejected', () => {
  const result = check(source(`
    export async function listTransactions(values: unknown[], options: { categoryCode?: string }): Promise<void> {
      const filters: string[] = [];
      if (options.categoryCode) {
        filters.push(\`category.code = '\${options.categoryCode}'\`);
      }
      await client.query(\`SELECT 1 FROM txn WHERE txn.user_id = $1 \${filters.join(' AND ')}\`, values);
    }
  `));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].message, /push/);
});
