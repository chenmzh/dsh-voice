/** Fail closed on unexpected files, binary assets, machine paths and common secrets. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
function walk(dir = '') {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) return [];
    const name = path.posix.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not publishable: ${name}`);
    return entry.isDirectory() ? walk(name) : [name];
  });
}
let files;
if (process.argv.includes('--staged')) {
  files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} else files = walk();
const allowedRoot = new Set(['.gitignore', 'LICENSE', 'README.md', 'INSTALL.md', 'PRIVACY.md', 'package.json', 'package-lock.json', 'cordis.patch.yml']);
const allowed = name => allowedRoot.has(name) || /^(lib|tests|tools)\/[\w./-]+\.(js|mjs|cjs|ts)$/.test(name)
  || /^python\/[\w-]+\.py$/.test(name) || /^python\/requirements[\w-]*\.txt$/.test(name);
const patterns = [
  ['absolute home path', /\/(?:home|Users)\/[^\s'"<>]+/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['API secret', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['embedded audio', /data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=]{256,}/],
  ['credential in URL', /https?:\/\/[^\s/]+:[^\s/@]+@/],
];
const issues = [];
for (const name of files) {
  if (!allowed(name)) { issues.push(`${name}: not on the source-file allowlist`); continue; }
  const bytes = process.argv.includes('--staged') ? execFileSync('git', ['show', `:${name}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 }) : readFileSync(path.join(root, name));
  if (bytes.includes(0)) { issues.push(`${name}: binary content`); continue; }
  for (const [label, pattern] of patterns) if (pattern.test(bytes.toString('utf8'))) issues.push(`${name}: ${label}`);
}
if (issues.length) { console.error(issues.join('\n')); process.exit(1); }
console.log(`Privacy check passed: ${files.length} source files; no media, model files, home paths or detected secrets.`);
