import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Run the real shell scripts, replacing every external service with a fake CLI.
// These tests need neither Azure/GitHub credentials nor a Docker daemon.
const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const scenario = env.SCENARIO;
fs.appendFileSync(env.CALL_LOG, JSON.stringify([tool, ...args]) + '\\n');
const calls = fs.readFileSync(env.CALL_LOG, 'utf8').trim().split('\\n').map(JSON.parse);
const query = args[args.indexOf('--query') + 1];
const value = flag => args[args.indexOf(flag) + 1];
const out = text => { process.stdout.write(text + '\\n'); process.exit(0); };
const revision = 'app--ci-123-1';
const digest = 'registry.azurecr.io/jaj-api@sha256:' + 'b'.repeat(64);
if (tool === 'sleep') process.exit(0);
if (tool === 'gh') {
  if (scenario === 'github-unavailable') process.exit(1);
  const count = calls.filter(c => c[0] === 'gh').length;
  out(scenario === 'stale' || (scenario === 'stale-before-update' && count > 1) ? 'old' : env.GITHUB_SHA);
}
if (tool === 'docker') {
  if (args[0] === 'image') out('sha256:' + (scenario === 'wrong-artifact' ? 'c' : 'a').repeat(64));
  if (args[0] === 'inspect') out(digest);
  process.exit(0);
}
if (tool === 'curl') {
  if (scenario === 'http-failure') process.exit(22);
  out(args.includes('--write-out') ? (scenario === 'demo-exposed' ? '200' : '404') : '');
}
if (tool !== 'az') throw new Error('Unexpected tool: ' + tool);
if (args[0] === 'acr') out(args[1] === 'show' ? 'registry.azurecr.io' : '');
if (args[1] === 'update') out(scenario === 'wrong-revision' ? 'other-revision' : revision);
if (args[1] === 'revision') {
  if (args[2] === 'list') out('safe revision diagnostics');
  if (query === 'properties.provisioningState') out(scenario === 'provisioning-failed' ? 'Failed' : 'Provisioning');
  if (query.includes('.image')) out(value('--revision') === 'previous-ready' ? 'registry.azurecr.io/jaj-api@sha256:' + 'd'.repeat(64) : scenario === 'wrong-deployed-image' ? 'wrong' : digest);
}
if (query === 'properties.configuration.activeRevisionsMode') out(scenario === 'multiple-mode' ? 'Multiple' : 'Single');
if (query === 'properties.template.containers[].name') out('api');
if (query === 'properties.latestReadyRevisionName') {
  const updated = calls.some(c => c[0] === 'az' && c[2] === 'update');
  out(!updated || ['timeout', 'provisioning-failed'].includes(scenario) ? 'previous-ready' : revision);
}
if (query === 'properties.configuration.ingress.fqdn') out('app.example.test');
throw new Error('Unexpected Azure command: ' + args.join(' '));
`;

function run(scenario, overrides = {}, script = 'deploy-azure.sh') {
  const dir = mkdtempSync(join(tmpdir(), 'jaj-deploy-test-'));
  try {
    for (const tool of ['az', 'gh', 'docker', 'curl', 'sleep']) {
      writeFileSync(join(dir, tool), fakeCli, { mode: 0o755 });
    }
    for (const file of ['calls', 'summary', 'output'])
      writeFileSync(join(dir, file), '');
    const result = spawnSync('bash', [resolve('scripts/ci', script)], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SCENARIO: scenario,
        CALL_LOG: join(dir, 'calls'),
        DEPLOYMENT_ENVIRONMENT: 'testing',
        GITHUB_REF: 'refs/heads/testing',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_OUTPUT: join(dir, 'output'),
        RUNNER_TEMP: dir,
        AZURE_CONTAINER_APP: 'app',
        AZURE_CONTAINER_NAME: 'api',
        AZURE_RESOURCE_GROUP: 'group',
        AZURE_ACR_NAME: 'registry',
        EXPECTED_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      calls: readFileSync(join(dir, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse),
      summary: readFileSync(join(dir, 'summary'), 'utf8'),
      output: readFileSync(join(dir, 'output'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const updates = (result) =>
  result.calls.filter((c) => c[0] === 'az' && c[2] === 'update');

test('deploys the verified digest, preserves rollback evidence, and checks production routes', () => {
  const result = run('success');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(updates(result).length, 1);
  assert.ok(
    updates(result)[0].includes(
      `registry.azurecr.io/jaj-api@sha256:${'b'.repeat(64)}`,
    ),
  );
  assert.match(result.summary, /Previous ready revision: previous-ready/);
  assert.match(result.summary, new RegExp('sha256:' + 'd'.repeat(64)));
  assert.match(result.output, /url=https:\/\/app.example.test/);
  assert.equal(result.calls.filter((c) => c[0] === 'curl').length, 4);
});

for (const [environment, branch] of [
  ['testing', 'testing'],
  ['staging', 'staging'],
  ['production', 'main'],
]) {
  test(`allows the current ${environment} branch`, () => {
    assert.equal(
      run(
        'success',
        {
          DEPLOYMENT_ENVIRONMENT: environment,
          GITHUB_REF: `refs/heads/${branch}`,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
        },
        'verify-release.sh',
      ).status,
      0,
    );
  });
}

for (const scenario of [
  'stale',
  'stale-before-update',
  'github-unavailable',
  'wrong-artifact',
  'multiple-mode',
]) {
  test(`rejects ${scenario} before changing the app`, () => {
    const result = run(scenario);
    assert.notEqual(result.status, 0);
    assert.equal(updates(result).length, 0);
    assert.match(result.summary, /Deployment exit code: 1/);
    if (scenario === 'wrong-artifact')
      assert.equal(
        result.calls.filter((c) => c[0] === 'docker' && c[1] === 'push').length,
        0,
      );
  });
}

for (const overrides of [
  { DEPLOYMENT_ENVIRONMENT: 'production' },
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_REF: 'refs/tags/v1' },
]) {
  test(`rejects an unauthorized release: ${JSON.stringify(overrides)}`, () => {
    const result = run('success', overrides, 'verify-release.sh');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 0);
  });
}

for (const scenario of [
  'wrong-revision',
  'provisioning-failed',
  'timeout',
  'wrong-deployed-image',
  'http-failure',
  'demo-exposed',
]) {
  test(`fails on ${scenario} and retains rollback evidence`, () => {
    const result = run(scenario);
    assert.notEqual(result.status, 0);
    assert.equal(
      updates(result).length,
      1,
      'never attempts automatic rollback',
    );
    assert.match(result.summary, /Previous ready revision: previous-ready/);
    assert.equal(result.output, '', 'does not report deployment success');
  });
}
