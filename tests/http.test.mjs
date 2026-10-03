import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, jiraClient, ApiError } from '../scripts/lib/http.mjs';
import { fixture } from './fixture.mjs';

test('OAuth credentials go only to the token endpoint and the minted token goes to Jira', async t => {
  const f = await fixture();
  t.after(f.close);
  const destinations = [];
  const fetcher = (url, options) => {
    const parsed = new URL(url);
    destinations.push(parsed.origin);
    return fetch(`${f.base}${parsed.pathname}${parsed.search}`, options);
  };
  const client = await jiraClient({
    site: f.base, clientId: 'test-client-id', clientSecret: 'test-client-secret', fetcher,
  });
  await client.request('/project/BRM');
  const oauth = f.state.requests.find(request => request.path === '/oauth/token');
  assert.equal(new URLSearchParams(oauth.body).get('grant_type'), 'client_credentials');
  assert.equal(new URLSearchParams(oauth.body).get('client_secret'), 'test-client-secret');
  assert.equal(destinations[1], 'https://auth.atlassian.com');
  assert.equal(destinations[2], 'https://api.atlassian.com');
  const request = f.state.requests.at(-1);
  assert.equal(request.headers.authorization, 'Bearer minted-secret');
  assert.equal(JSON.stringify(request).includes('test-client-secret'), false);
});

test('a failed write is attempted once and response secrets never enter the error', async () => {
  let calls = 0;
  const client = new HttpClient({ base: 'https://example.invalid/api', token: 'secret', service: 'Jira',
    fetcher: async () => {
      calls += 1;
      return new Response('private-response-secret', { status: 503 });
    },
  });
  await assert.rejects(client.request('/issue', { method: 'POST', body: {} }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('redirects are rejected instead of forwarding API credentials', async () => {
  const requests = [];
  const client = new HttpClient({ base: 'https://example.invalid', token: 'secret', service: 'Jira',
    fetcher: async (url, options) => {
      requests.push(options);
      return new Response('{}', { status: 302, headers: { location: 'https://other.invalid' } });
    },
  });
  await assert.rejects(client.request('/issue'), /HTTP 302/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, 'error');
});
