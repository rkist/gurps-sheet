// Replaces GURPS/ with a fresh copy of the sheet from a checkout of
// Roll20/roll20-character-sheets. Run it whenever the upstream sheet changes.
//
//   npm run sync                                  (expects ../roll20-character-sheets)
//   SHEET_SRC=/path/to/roll20-character-sheets/GURPS npm run sync
import { execFileSync } from 'node:child_process';
import { access, cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.SHEET_SRC || path.join(projectRoot, '..', 'roll20-character-sheets', 'GURPS'));
const dest = path.join(projectRoot, 'GURPS');

try {
  await access(path.join(src, 'gurps.html'));
} catch {
  console.error(`Could not find gurps.html in ${src}`);
  console.error('Set SHEET_SRC to the GURPS folder of a roll20-character-sheets checkout.');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await cp(src, dest, {
  recursive: true,
  filter: (file) => !['.DS_Store', 'node_modules'].includes(path.basename(file)),
});

// The sheet is MIT licensed by Roll20; keep the notice next to the copy.
try {
  await cp(path.join(src, '..', 'LICENSE'), path.join(dest, 'LICENSE'));
} catch {
  console.warn('Warning: LICENSE not found next to the GURPS folder; add it manually.');
}

let commit = null;
try {
  commit = execFileSync('git', ['-C', src, 'log', '-1', '--format=%H', '--', '.'], { encoding: 'utf8' }).trim() || null;
} catch {
  console.warn('Warning: could not read the upstream git commit.');
}

const html = await readFile(path.join(dest, 'gurps.html'), 'utf8');
const version = /const\s+version\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? 'unknown';
await writeFile(
  path.join(dest, 'UPSTREAM.json'),
  JSON.stringify(
    {
      repository: 'https://github.com/Roll20/roll20-character-sheets',
      path: 'GURPS',
      commit,
      version,
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);

console.log(`Copied GURPS sheet ${version}${commit ? ` (${commit.slice(0, 10)})` : ''} from ${src}`);
