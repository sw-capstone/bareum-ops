import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyFailure, failureMessage } from '../scripts/notify-failure.mjs';
import { failureCodes } from '../scripts/lib/failure.mjs';
import { failureMessages } from '../scripts/lib/failure-messages.mjs';

const environment = {
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/test-secret',
  GITHUB_REPOSITORY: 'sw-capstone/bareum-web',
  GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'issues',
};

test('every supported failure code has named cause and remedy messages', () => {
  assert.deepEqual(Object.keys(failureMessages).sort(), [...failureCodes].sort());
  for (const code of failureCodes) {
    const message = failureMessages[code]({ issue: 'ai 이슈 #14', service: 'Jira',
      login: 'unmapped-user', status: 503, method: 'POST' });
    assert.deepEqual(Object.keys(message).sort(), ['cause', 'remedy']);
    assert.equal(typeof message.cause, 'string');
    assert.equal(typeof message.remedy, 'string');
    assert.ok(message.cause.length > 0 && message.remedy.length > 0);
    const content = failureMessage({ ...environment, SYNC_FAILURE: JSON.stringify({ code,
      source: { repository: 'sw-capstone/bareum-ai', number: 14 },
      service: 'Jira', login: 'unmapped-user', status: 503, method: 'POST',
    }) }, { action: 'edited', issue: { number: 10 } });
    assert.ok(content.includes(`**원인:** ${message.cause}`));
    assert.ok(content.includes(`**조치:** ${message.remedy}`));
  }
});

test('temporary API read errors use retry guidance rather than uncertain-write guidance', () => {
  const message = failureMessage({ ...environment,
    SYNC_FAILURE: JSON.stringify({ code: 'temporary_api', service: 'Jira', status: 503, method: 'GET' }),
  }, {});
  assert.match(message, /잠시 후 재실행해주세요/);
  assert.doesNotMatch(message, /상태를 먼저 확인/);
});

test('failure notification links the caller run without secrets or mentions', async () => {
  let payload;
  await notifyFailure(environment, { action: 'opened', issue: { number: 10 } }, async (url, options) => {
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(options.redirect, 'error');
    payload = JSON.parse(options.body);
    return new Response(null, { status: 204 });
  });
  assert.match(payload.content, /web · 이슈 #10/);
  assert.match(payload.content, /https:\/\/github.com\/sw-capstone\/bareum-web\/actions\/runs\/42/);
  assert.equal(payload.content.includes('test-secret'), false);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('merged PR failure identifies its missing issue mapping and gives a specific repair', async () => {
  const message = failureMessage({ ...environment, GITHUB_REPOSITORY: 'sw-capstone/bareum-ai',
    SYNC_FAILURE: JSON.stringify({ code: 'mapping_missing',
      source: { repository: 'sw-capstone/bareum-ai', number: 14 } }),
  }, { action: 'closed', pull_request: { number: 15, merged: true } });
  assert.match(message, /ai · PR #15/);
  assert.match(message, /ai 이슈 #14의 Jira 연결을 찾지 못했습니다/);
  assert.match(message, /수동 동기화/);
  assert.match(message, /PR 병합은 정상 완료됐습니다/);
  assert.match(message, /일부 정보는 반영됐을 수 있습니다/);
});

test('unmerged and draft PRs never claim a successful merge', () => {
  for (const event of [
    { action: 'closed', pull_request: { number: 15, merged: false } },
    { action: 'converted_to_draft', pull_request: { number: 15, draft: true } },
    { action: 'opened', pull_request: { number: 15, merged: true } },
  ]) {
    assert.doesNotMatch(failureMessage(environment, event), /병합은 정상/);
  }
});

test('setup failures use the failed stage instead of claiming a Jira API failure', () => {
  for (const [stage, label] of Object.entries({ checkout: '공통 자동화 코드 준비',
    node: '실행 환경 준비', tests: '자동화 자체 테스트', bot: 'GitHub App 인증' })) {
    const message = failureMessage({ ...environment, FAILURE_STAGE: stage,
      SYNC_FAILURE: '{"code":"mapping_missing"}',
    }, { action: 'closed', pull_request: { number: 15, merged: true } });
    assert.ok(message.includes(label));
    assert.match(message, /Jira 동기화 단계는 실행되지 않았습니다/);
    assert.doesNotMatch(message, /Jira 연결을 찾지/);
  }
});

test('manual sync names the selected source rather than the ops caller', () => {
  const message = failureMessage({ ...environment, GITHUB_REPOSITORY: 'sw-capstone/bareum-ops',
    SYNC_REPOSITORY: 'sw-capstone/bareum-ai', SYNC_ISSUE_NUMBER: '14',
  }, {});
  assert.match(message, /대상:\*\* ai 이슈 #14 · 수동 동기화/);
});

test('unknown or malformed failures omit raw messages, secrets, and unvalidated fields', () => {
  for (const failure of ['{invalid secret', JSON.stringify({ code: 'secret-code',
    message: 'token-secret', login: '@everyone', service: 'token-secret',
    source: { repository: 'evil/secret', number: 1 } })]) {
    const message = failureMessage({ ...environment, SYNC_FAILURE: failure }, {});
    assert.match(message, /자동으로 분류하지 못했습니다/);
    assert.doesNotMatch(message, /secret|@everyone|evil/);
  }
});

test('temporary API writes advise checking partial results before retrying', () => {
  const message = failureMessage({ ...environment,
    SYNC_FAILURE: JSON.stringify({ code: 'temporary_api', service: 'Jira', status: 503, method: 'POST' }),
  }, {});
  assert.match(message, /HTTP 503/);
  assert.match(message, /상태를 먼저 확인/);
  assert.match(message, /새 티켓을 직접 만들지/);
});

test('an invalid webhook cannot receive a notification', async () => {
  let calls = 0;
  await assert.rejects(notifyFailure({ ...environment,
    DISCORD_WEBHOOK_URL: 'https://other.invalid/api/webhooks/123/token',
  }, {}, async () => { calls += 1; }), /Invalid Discord/);
  assert.equal(calls, 0);
});

test('Discord rejection does not leak its response or retry the write', async () => {
  let calls = 0;
  await assert.rejects(notifyFailure(environment, {}, async () => {
    calls += 1;
    return new Response('test-secret', { status: 429 });
  }), error => {
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes('test-secret'), false);
    return true;
  });
  assert.equal(calls, 1);
});
