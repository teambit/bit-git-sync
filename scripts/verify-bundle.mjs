/**
 * Verifies the committed action bundle (`dist/index.js`) is (1) up to date
 * with the component sources and (2) actually loadable by Node.
 *
 * Why this exists: `dist/index.js` is a build artifact that is nonetheless
 * COMMITTED, because `action.yml` points `main` at it and GitHub Actions runs
 * it verbatim with no build step. Nothing else in the test suite executes it,
 * so a bundle that is stale — or that crashes on load, as an accidentally
 * CommonJS-formatted bundle does under the root `"type": "module"` — passes
 * every unit test while being completely broken in production.
 *
 * Run with `npm run verify-bundle`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { bundleOptions, bundlePath, repoRoot } from './bundle-action.mjs';

/** Runs `node <args>` and captures exit code + merged output. */
function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const failures = [];

// --- Check 1: the committed bundle matches a fresh build of the sources. ---
const tempDir = await mkdtemp(join(tmpdir(), 'bit-git-sync-bundle-'));
try {
  const freshPath = join(tempDir, 'index.js');
  await build({ ...bundleOptions, outfile: freshPath });

  const [committed, fresh] = await Promise.all([readFile(bundlePath), readFile(freshPath)]);

  if (!committed.equals(fresh)) {
    failures.push(
      'dist/index.js is STALE: it differs from a fresh build of the component sources.\n' +
        '  Fix: run `npm run bundle` and commit the result.'
    );
  } else {
    console.log('ok  dist/index.js is byte-identical to a fresh build');
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

// --- Check 2: the committed bundle loads and runs under the real Node ESM loader. ---
// A `push` event with no GITHUB_EVENT_PATH routes to a skip, so this exercises
// module load + the full action wiring without ever spawning `git` or `bit`.
const smoke = await runNode([bundlePath], {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_EVENT_PATH: '',
  'INPUT_WS-DIR': '.',
});

if (smoke.code !== 0) {
  failures.push(`dist/index.js exited ${smoke.code} on a no-op \`push\` event (expected 0).\n  Output:\n${smoke.output}`);
} else if (!smoke.output.includes('[bit-git-sync] skipping')) {
  failures.push(`dist/index.js did not log the expected skip message.\n  Output:\n${smoke.output}`);
} else {
  console.log('ok  dist/index.js loads under Node ESM and routes a no-op push to a skip');
}

if (failures.length > 0) {
  console.error(`\nverify-bundle FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nverify-bundle passed');
}
