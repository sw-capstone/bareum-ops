import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SyncError, describeFailure, recordFailure } from '../scripts/lib/failure.mjs';
import { ApiError } from '../scripts/lib/http.mjs';
import { fixture } from './fixture.mjs';
import { failureMessage } from '../scripts/notify-failure.mjs';
import { assigneeWarning } from '../scripts/lib/assignees.mjs';

test('real missing mapping flows from PR processing to a source-specific Discord message', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.pulls.push({ repository: f.state.source.repository, number: 20,
    state: 'closed', merged: true, draft: false, body: 'Closes #10' });
  let failure;
  await assert.rejects(f.sync.pullRequest({ repository: f.state.source.repository, number: 20 }), error => {
    failure = describeFailure(error);
    assert.equal(failure.code, 'mapping_missing');
    assert.deepEqual(failure.source, f.state.source);
    return true;
  });
  assert.equal(f.state.creates, 0);
  const message = failureMessage({ GITHUB_REPOSITORY: f.state.source.repository,
    GITHUB_RUN_ID: '42', SYNC_FAILURE: JSON.stringify(failure) },
  { action: 'closed', pull_request: { number: 20, merged: true } });
  assert.match(message, /web 이슈 #10/);
  assert.match(message, /수동 동기화/);
});

test('unknown assignee reports a warning while the ticket sync succeeds', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.issue.assignees = [{ login: 'unmapped-user' }];
  const result = await f.sync.issue(f.state.source, 'assigned', []);
  assert.equal(result.warnings[0].code, 'assignee_missing');
  assert.match(assigneeWarning(result.warnings[0]), /unmapped-user.*매핑/);
  assert.equal(f.state.creates, 1);
});

test('HTTP failures are classified without exporting endpoint paths or raw errors', () => {
  for (const [status, code] of [[401, 'authentication'], [403, 'permission'],
    [429, 'temporary_api'], [503, 'temporary_api'], [400, 'api'], [404, 'api']]) {
    assert.deepEqual(describeFailure(new ApiError('Jira', status, 'POST', '/secret-path')), {
      version: 1, code, service: 'Jira', status, method: 'POST',
    });
  }
  assert.deepEqual(describeFailure(new TypeError('secret-token')), { version: 1, code: 'unknown' });
});

test('Actions output records only validated failure fields on one line', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jira-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  await recordFailure(new SyncError('mapping_missing', 'raw-secret', {
    source: { repository: 'sw-capstone/bareum-ai', number: 14 },
    login: 'secret\ninjected=value', token: 'raw-secret',
  }), { GITHUB_OUTPUT: output });
  const content = await readFile(output, 'utf8');
  assert.equal(content.split('\n').length, 2);
  assert.doesNotMatch(content, /secret|injected|token/);
  assert.deepEqual(JSON.parse(content.slice('failure='.length)), {
    version: 1, code: 'mapping_missing', source: { repository: 'sw-capstone/bareum-ai', number: 14 },
  });
});

test('CLI failure exits unsuccessfully and still emits notification data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jira-cli-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/jira-sync.mjs', import.meta.url))], {
    env: { JIRA_ASSIGNEE_MAP: 'invalid-secret', GITHUB_OUTPUT: output }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /invalid-secret/);
  const failure = JSON.parse((await readFile(output, 'utf8')).slice('failure='.length));
  assert.deepEqual(failure, { version: 1, code: 'configuration' });
});
