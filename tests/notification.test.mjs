import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyFailure } from '../scripts/notify-failure.mjs';

const environment = {
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/test-secret',
  GITHUB_REPOSITORY: 'sw-capstone/bareum-web',
  GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'issues',
};

test('failure notification links the caller run without secrets or mentions', async () => {
  let payload;
  await notifyFailure(environment, { action: 'opened', issue: { number: 10 } }, async (url, options) => {
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(options.redirect, 'error');
    payload = JSON.parse(options.body);
    return new Response(null, { status: 204 });
  });
  assert.match(payload.content, /Issue #10/);
  assert.match(payload.content, /https:\/\/github.com\/sw-capstone\/bareum-web\/actions\/runs\/42/);
  assert.equal(payload.content.includes('test-secret'), false);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
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
