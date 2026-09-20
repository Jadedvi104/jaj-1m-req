import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = resolve('scripts/prepare-production.mjs');
const defaults = {
  AZURE_LOCATION: 'southeastasia',
  AZURE_PREFIX: 'prod',
  AZURE_ACR_NAME: 'prodregistry',
  AZURE_KEY_VAULT: 'prodvault',
  AZURE_RESOURCE_GROUP: 'rg-prod',
  AZURE_PG_SERVER: 'prodpostgres',
  AZURE_EVENTHUB_NAMESPACE: 'prodbroker',
  ALERT_EMAIL: 'ops@example.test',
  AZURE_PG_SKU: 'Standard_D2s_v3',
  AZURE_CONTAINER_APP: 'prodapi',
  AZURE_PIPELINE_PRINCIPAL_ID: '00000000-0000-0000-0000-000000000001',
  PG_ADMIN_PASSWORD: 'test-admin-password-1234',
  PG_APP_PASSWORD: 'test-app-password-$()-#-5678',
  KBANK_WEBHOOK_TOKEN: 'test-only-adapter-token-12345678901234567890',
  IMAGE_DIGEST: 'prodregistry.azurecr.io/jaj-api@sha256:' + 'a'.repeat(64),
};

function run(args, overrides, inspect) {
  const dir = mkdtempSync(join(tmpdir(), 'jaj-production-params-'));
  try {
    mkdirSync(join(dir, 'infra'));
    const env = Object.entries(defaults)
      .map(([key, value]) => `PRODUCTION_${key}='${value}'`)
      .join('\n');
    writeFileSync(join(dir, '.env'), env);
    writeFileSync(
      join(dir, '.env.local'),
      Object.entries(overrides)
        .map(([key, value]) => `PRODUCTION_${key}='${value}'`)
        .join('\n'),
    );
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    for (const secret of [
      'PG_ADMIN_PASSWORD',
      'PG_APP_PASSWORD',
      'KBANK_WEBHOOK_TOKEN',
    ]) {
      assert.ok(
        !(result.stdout + result.stderr).includes(defaults[secret]),
        'secrets must not appear in diagnostics',
      );
    }
    assert.equal(
      readFileSync(join(dir, '.env'), 'utf8'),
      env,
      'existing dotenv settings are preserved',
    );
    inspect(result, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writes private parameters with local precedence and literal secret characters', () => {
  run(
    ['foundation'],
    { ALERT_EMAIL: 'override@example.test' },
    (result, dir) => {
      assert.equal(result.status, 0, result.stderr);
      const path = join(
        dir,
        'infra/production-foundation.parameters.local.json',
      );
      const output = JSON.parse(readFileSync(path, 'utf8')).parameters;
      assert.equal(output.alertEmail.value, 'override@example.test');
      assert.equal(
        output.applicationDatabasePassword.value,
        defaults.PG_APP_PASSWORD,
      );
      assert.equal(statSync(path).mode & 0o777, 0o600);
    },
  );
});
test('dry run writes no parameter file', () => {
  run(['foundation', '--check'], {}, (result, dir) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(
        join(dir, 'infra/production-foundation.parameters.local.json'),
      ),
      false,
    );
  });
});
test('missing production credentials fail without falling back to development', () => {
  run(['foundation'], { PG_APP_PASSWORD: '' }, (result, dir) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Set PRODUCTION_PG_APP_PASSWORD/);
    assert.equal(
      existsSync(
        join(dir, 'infra/production-foundation.parameters.local.json'),
      ),
      false,
    );
  });
});
test('rejects a mutable image tag', () => {
  run(
    ['app'],
    { IMAGE_DIGEST: 'prodregistry.azurecr.io/jaj-api:latest' },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /verified jaj-api sha256 digest/);
    },
  );
});
test('rejects a digest in a development registry', () => {
  run(
    ['app'],
    { IMAGE_DIGEST: 'devregistry.azurecr.io/jaj-api@sha256:' + 'a'.repeat(64) },
    (result) => {
      assert.notEqual(result.status, 0);
    },
  );
});
test('app bootstrap keeps ingress restricted and contains no database passwords', () => {
  run(['app'], {}, (result, dir) => {
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(
      join(dir, 'infra/production-app.parameters.local.json'),
      'utf8',
    );
    assert.equal(JSON.parse(content).parameters.externalIngress.value, false);
    assert.equal(content.includes(defaults.PG_APP_PASSWORD), false);
  });
});
