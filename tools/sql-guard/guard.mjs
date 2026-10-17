#!/usr/bin/env node
/**
 * Static SQL guard for the database layer.
 *
 * Every runtime statement in `packages/database/src` must reach `pg` as a string
 * literal plus a `$n` parameter array. This guard parses the TypeScript sources
 * with `@babel/parser` and checks the first argument of every SQL execution
 * point, so a value that only arrives at runtime can never silently become part
 * of the statement text.
 *
 * An execution point is either
 *   - a call to `.query(...)` on any object (`client.query`, `this.pool.query`,
 *     `transaction.query`, …), or
 *   - a call to a function/method this file proves to be a *passthrough*: one
 *     that forwards its own parameter, unchanged, into a `.query()` call (or
 *     into another passthrough). Passthrough call sites are checked with the
 *     same rules, so the safety of a wrapper is decided where its text is
 *     written, not where the wrapper is defined.
 *
 * The first argument is accepted only when it is one of:
 *   - a string literal or a template literal without substitutions;
 *   - a template literal whose substitutions are, recursively:
 *       * numeric (a number can carry no SQL text): `values.length`,
 *         `values.length - 1`, numeric literals and arithmetic on them;
 *       * a binding (const/let/var) that is, at *every* assignment in the file,
 *         one of these accepted forms — so a `let` rewritten with caller text
 *         fails the guard;
 *       * `array.join(<literal>)` where every element written into that array in
 *         this file (initializer elements and `.push(...)` arguments) is itself
 *         an accepted form;
 *       * a conditional whose two branches are accepted forms.
 * Anything else — string concatenation, a parameter, a function call, a member
 * access such as `req.body.sql`, a `sql.raw(...)` helper — is a violation.
 *
 * The check is fail-closed: an expression shape that is not modelled is a
 * violation, and a file that cannot be parsed aborts the run.
 *
 * Deliberate exemptions are listed in EXEMPTIONS with a reason, and every entry
 * must still match exactly one call site; a stale entry also fails the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const DEFAULT_TARGET = path.join(REPO_ROOT, 'packages/database/src');

/**
 * Reviewed, narrow exemptions. Each entry must match exactly one call site and
 * carries the reason the argument is trusted even though it is not a literal.
 */
export const EXEMPTIONS = Object.freeze([
  Object.freeze({
    file: 'packages/database/src/migrations.ts',
    function: 'applyMigration',
    argument: 'migration.sql',
    reason:
      'The migration runner executes a file it selected from its own directory: the name must match '
      + '/^[0-9]{4}_[a-z0-9_]+\\.sql$/, the text is read from the checked-in migrations directory, and the '
      + 'SHA-256 is compared with kfin_migrations before the statement runs. No request value reaches it.',
  }),
]);

const FUNCTION_LIKE = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
]);

const TRANSPARENT = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
]);

function unwrap(node) {
  let current = node;
  while (current && TRANSPARENT.has(current.type)) current = current.expression;
  return current;
}

function propertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'StringLiteral') return member.property.value;
  return null;
}

function isFunctionLike(node) {
  return Boolean(node) && FUNCTION_LIKE.has(node.type);
}

function enclosingFunction(node, parents) {
  let current = parents.get(node);
  while (current) {
    if (isFunctionLike(current)) return current;
    current = parents.get(current);
  }
  return null;
}

function functionName(node, parents) {
  if (!node) return null;
  if (node.id && node.id.type === 'Identifier') return node.id.name;
  if ((node.type === 'ClassMethod' || node.type === 'ObjectMethod') && node.key.type === 'Identifier') {
    return node.key.name;
  }
  const parent = parents.get(node);
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') return parent.left.name;
  return null;
}

function nearestScope(node, parents) {
  let current = parents.get(node);
  while (current) {
    if (current.type === 'Program') return current;
    if (current.type === 'BlockStatement') return current;
    current = parents.get(current);
  }
  return null;
}

function inside(node, container) {
  return Boolean(node && container) && node.start >= container.start && node.end <= container.end;
}

const ARITHMETIC = new Set(['-', '*', '/', '%', '**']);

/**
 * Analyses one TypeScript source and returns its violations plus statistics.
 * Exposed for the guard's own tests; the CLI below runs it over a directory.
 */
export function analyzeSource(code, options = {}) {
  const filename = options.filename ?? '<fixture>.ts';
  const exemptions = options.exemptions ?? EXEMPTIONS;
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript'],
    errorRecovery: false,
    attachComment: false,
  });

  const parents = new Map();
  const calls = [];
  const queryCalls = [];
  const declarations = [];
  const assignments = [];
  const arrayPushes = [];
  const functions = [];
  const queryAliases = new Set(); // names bound to a pg query function
  const applyBypass = [];

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (parent) parents.set(node, parent);
    if (isFunctionLike(node)) functions.push(node);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      declarations.push({
        name: node.id.name,
        init: node.init,
        kind: parent?.kind ?? 'const',
        scope: nearestScope(node, parents),
        node,
      });
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      assignments.push({
        name: node.left.name,
        operator: node.operator,
        value: node.right,
        scope: nearestScope(node, parents),
        node,
      });
    }
    if (
      node.type === 'CallExpression'
      && propertyName(node.callee) === 'push'
      && node.callee.object.type === 'Identifier'
    ) {
      arrayPushes.push({
        name: node.callee.object.name,
        argument: node.arguments[0],
        scope: nearestScope(node, parents),
        node,
      });
    }
    if (node.type === 'VariableDeclarator') {
      // `const q = client.query` and `const { query } = client` are the same
      // execution point under another name; both are tracked so their call
      // sites are checked instead of silently skipped.
      const init = node.init ? unwrap(node.init) : null;
      if (node.id.type === 'Identifier' && init?.type === 'MemberExpression' && propertyName(init) === 'query') {
        queryAliases.add(node.id.name);
      }
      if (node.id.type === 'ObjectPattern') {
        for (const property of node.id.properties) {
          if (property.type === 'ObjectProperty' && property.key.type === 'Identifier' && property.key.name === 'query') {
            const local = property.value.type === 'Identifier' ? property.value.name : 'query';
            queryAliases.add(local);
          }
        }
      }
    }
    if (node.type === 'CallExpression') {
      calls.push(node);
      if (propertyName(node.callee) === 'query') queryCalls.push(node);
      // `client.query.apply(...)` hides the statement inside an array, so it is
      // reported instead of modelled; `client.query.call(client, text)` is just
      // another way to write an execution point with the text first.
      const viaCall = node.callee.type === 'MemberExpression' ? node.callee : null;
      if (viaCall && (propertyName(viaCall) === 'apply' || propertyName(viaCall) === 'call')
        && viaCall.object.type === 'MemberExpression' && propertyName(viaCall.object) === 'query') {
        if (propertyName(viaCall) === 'apply') applyBypass.push(node);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra'
        || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node);
      } else if (value && typeof value.type === 'string') {
        visit(value, node);
      }
    }
  };
  visit(ast, null);

  const resolve = (name, node) => {
    const candidates = declarations.filter((declaration) => (
      declaration.name === name
      && inside(node, declaration.scope)
      && !(declaration.init && inside(node, declaration.init))
    ));
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => (
      (left.scope.end - left.scope.start) - (right.scope.end - right.scope.start)
    ));
    if (candidates.length > 1) {
      const a = candidates[0].scope.end - candidates[0].scope.start;
      const b = candidates[1].scope.end - candidates[1].scope.start;
      if (a === b) return null; // ambiguous scope: fail closed
    }
    return candidates[0];
  };

  const assignmentsOf = (declaration) => assignments.filter((assignment) => (
    resolve(assignment.name, assignment.node) === declaration
  ));

  const pushesOf = (declaration) => arrayPushes.filter((push) => (
    resolve(push.name, push.node) === declaration
  ));

  const parameterNames = (fn) => new Set(
    fn.params
      .map((param) => unwrap(param))
      .filter((param) => param?.type === 'Identifier')
      .map((param) => param.name),
  );

  // ── numeric expressions ────────────────────────────────────────────────────
  const numericCache = new Map();
  const isNumeric = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return false;
    if (numericCache.has(current)) return numericCache.get(current);
    let result = false;
    if (current.type === 'NumericLiteral') result = true;
    else if (current.type === 'MemberExpression' && propertyName(current) === 'length') result = true;
    else if (current.type === 'BinaryExpression' && ARITHMETIC.has(current.operator)) {
      result = isNumeric(current.left, seen) && isNumeric(current.right, seen);
    } else if (
      current.type === 'UnaryExpression' && ['-', '+'].includes(current.operator)
    ) {
      result = isNumeric(current.argument, seen);
    } else if (current.type === 'Identifier') {
      const declaration = resolve(current.name, current);
      if (declaration && !seen.has(declaration) && declaration.init) {
        const next = new Set(seen).add(declaration);
        result = isNumeric(declaration.init, next)
          && assignmentsOf(declaration).every((assignment) => (
            assignment.operator === '=' && isNumeric(assignment.value, next)
          ));
      }
    }
    numericCache.set(current, result);
    return result;
  };

  // ── safe SQL text ──────────────────────────────────────────────────────────
  const safeCache = new Map();
  const isSafeText = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return { safe: false, reason: 'missing expression' };
    if (safeCache.has(current)) return safeCache.get(current);
    const verdict = (result) => {
      safeCache.set(current, result);
      return result;
    };

    if (current.type === 'StringLiteral') return verdict({ safe: true, category: 'literal' });
    if (current.type === 'TemplateLiteral') {
      if (current.expressions.length === 0) return verdict({ safe: true, category: 'literal' });
      for (const expression of current.expressions) {
        const fragment = isSafeFragment(expression, seen);
        if (!fragment.safe) return verdict({ safe: false, reason: fragment.reason });
      }
      return verdict({ safe: true, category: 'template' });
    }
    if (current.type === 'NumericLiteral') return verdict({ safe: true, category: 'numeric' });
    if (current.type === 'Identifier') {
      const declaration = resolve(current.name, current);
      if (!declaration) {
        return verdict({ safe: false, reason: `\`${current.name}\` is not a local literal or reviewed fragment` });
      }
      if (seen.has(declaration)) return verdict({ safe: false, reason: `\`${current.name}\` is self-referential` });
      const next = new Set(seen).add(declaration);
      if (!declaration.init) {
        return verdict({ safe: false, reason: `\`${current.name}\` is declared without an initializer` });
      }
      const initial = isSafeText(declaration.init, next);
      if (!initial.safe) return verdict({ safe: false, reason: `\`${current.name}\` is initialized from ${initial.reason}` });
      for (const assignment of assignmentsOf(declaration)) {
        if (assignment.operator !== '=') {
          return verdict({ safe: false, reason: `\`${current.name}\` is changed with \`${assignment.operator}\`` });
        }
        const updated = isSafeText(assignment.value, next);
        if (!updated.safe) return verdict({ safe: false, reason: `\`${current.name}\` is reassigned from ${updated.reason}` });
      }
      return verdict({ safe: true, category: 'binding' });
    }
    if (current.type === 'MemberExpression') {
      if (propertyName(current) === 'length') return verdict({ safe: true, category: 'numeric' });
      return verdict({ safe: false, reason: 'member access (runtime value)' });
    }
    if (current.type === 'BinaryExpression') {
      if (current.operator === '+') {
        // Concatenation is how caller text would normally reach a statement, so
        // it is accepted only when both sides are numbers.
        if (isNumeric(current.left) && isNumeric(current.right)) {
          return verdict({ safe: true, category: 'numeric' });
        }
        return verdict({ safe: false, reason: 'string concatenation' });
      }
      if (ARITHMETIC.has(current.operator) && isNumeric(current.left) && isNumeric(current.right)) {
        return verdict({ safe: true, category: 'numeric' });
      }
      return verdict({ safe: false, reason: `binary \`${current.operator}\` on a non-numeric operand` });
    }
    if (current.type === 'ConditionalExpression') {
      const consequent = isSafeText(current.consequent, seen);
      if (!consequent.safe) return verdict({ safe: false, reason: consequent.reason });
      const alternate = isSafeText(current.alternate, seen);
      if (!alternate.safe) return verdict({ safe: false, reason: alternate.reason });
      return verdict({ safe: true, category: 'conditional' });
    }
    if (current.type === 'CallExpression') {
      const joined = isSafeJoin(current, seen);
      if (joined.safe) return verdict(joined);
      return verdict({ safe: false, reason: joined.reason });
    }
    return verdict({ safe: false, reason: `${current.type} is not an accepted SQL text form` });
  };

  const isSafeFragment = (node, seen) => {
    if (isNumeric(node, seen)) return { safe: true, category: 'numeric' };
    return isSafeText(node, seen);
  };

  const isSafeJoin = (call, seen) => {
    if (propertyName(call.callee) !== 'join') {
      return { safe: false, reason: 'function call (runtime value)' };
    }
    const separator = call.arguments[0];
    const separatorOk = !separator
      || separator.type === 'StringLiteral'
      || (separator.type === 'TemplateLiteral' && separator.expressions.length === 0);
    if (!separatorOk) return { safe: false, reason: 'join() with a non-literal separator' };
    const target = unwrap(call.callee.object);
    if (target?.type !== 'Identifier') return { safe: false, reason: 'join() on an unresolved receiver' };
    const declaration = resolve(target.name, target);
    if (!declaration) return { safe: false, reason: `\`${target.name}\` is not a local array` };
    if (seen.has(declaration)) return { safe: false, reason: `\`${target.name}\` is self-referential` };
    const next = new Set(seen).add(declaration);
    const elements = [];
    if (declaration.init) {
      const init = unwrap(declaration.init);
      if (init.type !== 'ArrayExpression') {
        return { safe: false, reason: `\`${target.name}\` is not initialized as an array` };
      }
      elements.push(...init.elements);
    }
    for (const assignment of assignmentsOf(declaration)) {
      const value = unwrap(assignment.value);
      if (assignment.operator !== '=' || value?.type !== 'ArrayExpression') {
        return { safe: false, reason: `\`${target.name}\` is reassigned from a non-literal array` };
      }
      elements.push(...value.elements);
    }
    const pushes = pushesOf(declaration);
    if (pushes.length === 0) {
      return { safe: false, reason: `\`${target.name}\` is never populated in this file` };
    }
    for (const element of elements) {
      if (!element) return { safe: false, reason: `\`${target.name}\` contains a hole` };
      const verdict = isSafeText(element, next);
      if (!verdict.safe) return { safe: false, reason: `\`${target.name}\` element: ${verdict.reason}` };
    }
    for (const push of pushes) {
      if (!push.argument) return { safe: false, reason: `\`${target.name}\`.push() without an argument` };
      const verdict = isSafeText(push.argument, next);
      if (!verdict.safe) return { safe: false, reason: `\`${target.name}\`.push: ${verdict.reason}` };
    }
    return { safe: true, category: 'joined-fragments' };
  };

  // ── passthrough helpers ────────────────────────────────────────────────────
  const passthroughByFunction = new Map(); // function node -> param index
  const definitionCalls = new Set();
  const nameOf = new Map();
  for (const fn of functions) nameOf.set(fn, functionName(fn, parents));
  const passthroughByName = new Map(); // name -> { paramIndex, node }

  const record = (fn, paramIndex, callNode) => {
    // Every call that forwards a parameter is a *definition* of the wrapper, not
    // a caller, even when the same function forwards from two branches.
    definitionCalls.add(callNode);
    if (passthroughByFunction.get(fn) === paramIndex) return false;
    passthroughByFunction.set(fn, paramIndex);
    const name = nameOf.get(fn);
    if (name && !passthroughByName.has(name)) passthroughByName.set(name, { paramIndex, node: fn });
    return true;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const argument = call.arguments[0];
      if (!argument) continue;
      const owner = enclosingFunction(call, parents);
      if (!owner) continue;
      const params = parameterNames(owner);
      const calleeIsQuery = propertyName(call.callee) === 'query';
      const calleeIdentifier = call.callee.type === 'Identifier' ? call.callee.name : null;

      let forwarded = null;
      if (argument.type === 'Identifier' && params.has(argument.name)) {
        if (calleeIsQuery) forwarded = argument.name;
      }
      if (!forwarded && calleeIdentifier && passthroughByName.has(calleeIdentifier)) {
        const target = passthroughByName.get(calleeIdentifier);
        const passed = call.arguments[target.paramIndex];
        if (passed?.type === 'Identifier' && params.has(passed.name)) forwarded = passed.name;
      }
      if (!forwarded) continue;
      const index = owner.params.map((param) => unwrap(param)).findIndex((param) => (
        param?.type === 'Identifier' && param.name === forwarded
      ));
      if (index < 0) continue;
      if (record(owner, index, call)) changed = true;
    }
  }

  // ── checks ─────────────────────────────────────────────────────────────────
  const violations = [];
  const stats = {
    files: 1,
    calls: 0,
    literal: 0,
    template: 0,
    binding: 0,
    numeric: 0,
    conditional: 0,
    'joined-fragments': 0,
    'passthrough-definition': 0,
    exempted: 0,
  };
  const details = [];
  const exemptionHits = new Map();

  const report = (node, message) => {
    violations.push({ file: filename, line: node.loc?.start.line ?? 0, message });
  };

  const checkArgument = (node, label) => {
    const verdict = isSafeText(node);
    if (!verdict.safe) {
      report(node, `${label}: ${verdict.reason}`);
    }
    return verdict;
  };

  for (const bypass of applyBypass) {
    report(bypass, 'SQL statement passed through `.query.apply(...)`, which the guard does not model');
  }

  for (const call of calls) {
    const isQueryMember = propertyName(call.callee) === 'query';
    const isQueryCall = call.callee.type === 'MemberExpression'
      && propertyName(call.callee) === 'call'
      && call.callee.object.type === 'MemberExpression'
      && propertyName(call.callee.object) === 'query';
    const calleeName = call.callee.type === 'Identifier' ? call.callee.name : null;
    const isAliasedQuery = Boolean(calleeName) && queryAliases.has(calleeName);
    const passthrough = calleeName ? passthroughByName.get(calleeName) : null;
    if (!isQueryMember && !isQueryCall && !isAliasedQuery && !passthrough) continue;
    stats.calls += 1;
    let index = 0;
    if (passthrough && !isQueryMember && !isQueryCall && !isAliasedQuery) index = passthrough.paramIndex;
    else if (isQueryCall) index = 1; // .call(receiver, text, values)
    const argument = call.arguments[index];
    const line = call.loc?.start.line ?? 0;

    if (definitionCalls.has(call)) {
      stats['passthrough-definition'] += 1;
      details.push({ file: filename, line, kind: 'passthrough-definition', text: code.slice(call.start, call.end).split('\n')[0].trim().slice(0, 90) });
      continue;
    }

    if (!argument) {
      report(call, 'SQL call without a statement argument');
      continue;
    }

    const exemption = exemptions.find((entry) => (
      entry.file === filename
      && entry.function === (functionName(enclosingFunction(call, parents), parents) ?? '')
      && entry.argument === code.slice(argument.start, argument.end).trim()
    ));
    if (exemption) {
      exemptionHits.set(exemption, (exemptionHits.get(exemption) ?? 0) + 1);
      stats.exempted += 1;
      details.push({ file: filename, line, kind: 'exempted', text: exemption.argument });
      continue;
    }

    const verdict = checkArgument(
      argument,
      isQueryMember || isQueryCall || isAliasedQuery
        ? 'SQL statement'
        : `argument ${index} of passthrough \`${calleeName}\``,
    );
    if (verdict.safe) stats[verdict.category] = (stats[verdict.category] ?? 0) + 1;
    details.push({
      file: filename,
      line,
      kind: verdict.safe ? verdict.category : 'VIOLATION',
      text: code.slice(argument.start, argument.end).split('\n')[0].trim().slice(0, 90),
    });
  }

  // A passthrough whose name is exported could be called from a file this run
  // does not see; require it to be reviewed instead of silently trusting it.
  const isExported = (node) => {
    if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
      let owner = parents.get(node);
      while (owner && owner.type !== 'ClassDeclaration' && owner.type !== 'ClassExpression') {
        owner = parents.get(owner);
      }
      const outer = owner ? parents.get(owner) : null;
      return outer?.type === 'ExportNamedDeclaration' || outer?.type === 'ExportDefaultDeclaration';
    }
    let current = node;
    while (current && current.type !== 'Program') {
      if (current.type === 'ExportNamedDeclaration' || current.type === 'ExportDefaultDeclaration') return true;
      // A local wrapper inside a function or method is not exported even when
      // the function or class that contains it is.
      if (current !== node && isFunctionLike(current)) return false;
      current = parents.get(current);
    }
    return false;
  };
  for (const [name, entry] of passthroughByName) {
    if (isExported(entry.node)) {
      report(entry.node, `execution passthrough \`${name}\` is exported; callers outside the scanned tree cannot be checked`);
    }
  }

  return { violations, stats, details, exemptionHits };
}

/** Analyses every `.ts` file in a directory (non-recursive by default). */
export function analyzeProject(directory = DEFAULT_TARGET, options = {}) {
  const target = path.isAbsolute(directory) ? directory : path.join(REPO_ROOT, directory);
  const recursive = options.recursive ?? false;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(target);
      } else if (entry.name.endsWith('.ts')) {
        files.push(target);
      }
    }
  };
  walk(target);

  const violations = [];
  const stats = { files: files.length };
  const details = [];
  const exemptionHits = new Map();
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const result = analyzeSource(fs.readFileSync(file, 'utf8'), {
      filename: relative,
      exemptions: options.exemptions ?? EXEMPTIONS,
    });
    violations.push(...result.violations);
    details.push(...result.details);
    for (const [key, value] of Object.entries(result.stats)) {
      if (key === 'files') continue;
      stats[key] = (stats[key] ?? 0) + value;
    }
    for (const [entry, count] of result.exemptionHits) {
      exemptionHits.set(entry, (exemptionHits.get(entry) ?? 0) + count);
    }
  }
  for (const entry of options.exemptions ?? EXEMPTIONS) {
    if (!exemptionHits.has(entry)) {
      violations.push({
        file: entry.file,
        line: 0,
        message: `stale exemption: no call site matches \`${entry.argument}\` in \`${entry.function}\`; remove or update the entry`,
      });
    }
  }
  return { violations, stats, details, exemptionHits };
}

function formatStats(stats) {
  const order = [
    'literal', 'template', 'binding', 'conditional', 'joined-fragments',
    'numeric', 'passthrough-definition', 'exempted',
  ];
  return order
    .filter((key) => stats[key])
    .map((key) => `${key} ${stats[key]}`)
    .join(' · ');
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const target = args.find((argument) => !argument.startsWith('--')) ?? DEFAULT_TARGET;
  const directory = path.isAbsolute(target) ? target : path.join(REPO_ROOT, target);

  if (!fs.existsSync(directory)) {
    console.error(`SQL guard: target not found: ${directory}`);
    process.exit(2);
  }

  const { violations, stats, details } = analyzeProject(directory);
  console.log(`SQL guard — ${path.relative(REPO_ROOT, directory) || directory}`);
  console.log(`  files scanned:   ${stats.files}`);
  console.log(`  execution sites: ${stats.calls} (${formatStats(stats) || 'none'})`);
  if (verbose) {
    for (const entry of details) {
      console.log(`    ${entry.file}:${entry.line}  ${entry.kind.padEnd(22)} ${entry.text}`);
    }
  }
  if (violations.length === 0) {
    console.log('  violations: 0');
    console.log('OK');
    return;
  }
  console.log(`  violations: ${violations.length}`);
  for (const violation of violations) {
    console.log(`  FAIL ${violation.file}:${violation.line} — ${violation.message}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
