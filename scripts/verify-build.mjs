import fs from 'node:fs';

const code = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

const failures = [];

// 1. Full JavaScript syntax parse.
try {
  new Function(code);
} catch (err) {
  failures.push('JavaScript syntax error: ' + err.message);
}

// 2. Storyline's $ helper is querySelector (single element).
// Calling collection methods on it is always a bug; those require $$.
const collectionMethods = ['forEach','map','filter','some','every','reduce','find','findIndex'];
const pattern = /(^|[^$])\$\(([^\n;]*?)\)\.(forEach|map|filter|some|every|reduce|find|findIndex)\s*\(/gm;
for (const match of code.matchAll(pattern)) {
  const before = code.slice(0, match.index).split('\n');
  const line = before.length;
  failures.push(
    `Single-element $() selector used with .${match[3]}() near line ${line}. Use $$() for collections.`
  );
}

// 3. Guard the specific reader selector that previously caused startup crashes.
const badReaderPattern = /(^|[^$])\$\('#readingPage p'\)\.(forEach|map)\s*\(/gm;
for (const match of code.matchAll(badReaderPattern)) {
  const line = code.slice(0, match.index).split('\n').length;
  failures.push(`Reader paragraph collection uses $() instead of $$() near line ${line}.`);
}

if (failures.length) {
  console.error('\nStoryline preflight FAILED:\n');
  for (const failure of failures) console.error('• ' + failure);
  console.error('\nBuild must not be published.\n');
  process.exit(1);
}

console.log('Storyline preflight passed: syntax and selector checks are clean.');
