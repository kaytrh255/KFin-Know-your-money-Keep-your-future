import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidenceRoot = path.join(root, 'evidence/spec-fin-02');
const files = walk(evidenceRoot).filter((file) => file.endsWith('.mjs'));
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const forbidden = [
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i,
  /DATABASE_URL\s*=\s*postgres/i,
  /SUPABASE_DB_PASSWORD\s*=/i,
];
const inspect = [
  path.join(root, '.gitignore'),
  path.join(root, 'package.json'),
  ...walk(evidenceRoot).filter((file) => !file.includes(`${path.sep}.runtime${path.sep}`)),
];
for (const file of inspect) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(content)) throw new Error(`Potential hard-coded database secret in ${path.relative(root, file)}`);
  }
}

console.log(`Checked ${files.length} JavaScript modules and ${inspect.length} harness files.`);

function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(target));
    else output.push(target);
  }
  return output;
}
