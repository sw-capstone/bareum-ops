import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { fixture } from './fixture.mjs';

async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  return f;
}

test('issue creation records both links and repeat execution creates no duplicate', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.creates, 1);
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /bareum.atlassian.net\/browse\/BRM-1/);
  assert.deepEqual(state.tickets.get('BRM-1').source, state.source);
  assert.equal(state.tickets.get('BRM-1').fields.summary, 'web · [Feat] Login');
  assert.equal(state.issue.title, '[Feat] Login');
  assert.equal(Object.keys(state.tickets.get('BRM-1').links).length, 1);
});

test('metadata edits preserve Jira planning fields and manual start', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get('BRM-1');
  ticket.fields.summary = '[Feat] Login';
  ticket.fields.status.id = config.statuses.progress;
  state.issue.title = '[Feat] Revised login';
  state.issue.body = 'Updated requirements';
  await sync.issue(state.source, 'edited', []);
  assert.equal(ticket.fields.summary, 'web · [Feat] Revised login');
  assert.equal(state.issue.title, '[Feat] Revised login');
  assert.equal(ticket.fields.status.id, config.statuses.progress);
  assert.equal(ticket.fields.priority.name, 'High');
  assert.equal(ticket.fields.sprint, 7);
  assert.equal(ticket.fields.estimate, 5);
  assert.equal(ticket.fields.epic, 'BRM-99');
});

test('ready PR, merge with open issue, and closed issue produce distinct states', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.pulls.push({ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Closes #10' });
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.review);
  assert.equal(state.tickets.get('BRM-1').links['github-pr:sw-capstone/bareum-web#20'].url,
    'https://github.com/sw-capstone/bareum-web/pull/20');
  state.pulls[0].state = 'closed';
  state.pulls[0].merged = true;
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.progress);
  state.issue.state = 'closed';
  state.issue.state_reason = 'completed';
  await sync.issue(state.source, 'closed', []);
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.done);
});

test('removing the last PR reference moves the old ticket out of review', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.tickets.get('BRM-1').fields.status.id = config.statuses.review;
  state.pulls.push({ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'No issue link' });
  await sync.pullRequest({ repository: state.source.repository, number: 20 }, 'Closes #10');
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.progress);
});

test('unlinked PR never creates a Jira ticket or mapping comment', async t => {
  const { sync, state } = await setup(t);
  state.pulls.push({ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Maintenance' });
  assert.deepEqual(await sync.pullRequest({ repository: state.source.repository, number: 20 }), []);
  assert.equal(state.creates, 0);
  assert.equal(state.comments.length, 0);
});

test('unknown creation result blocks a duplicate until Jira indexing recovers the first ticket', async t => {
  const { sync, state } = await setup(t);
  state.createFailure = 'ambiguous';
  await assert.rejects(sync.issue(state.source, 'opened', []), /HTTP 503/);
  state.searchVisible = false;
  await assert.rejects(sync.issue(state.source, 'opened', []), /may have succeeded/);
  assert.equal(state.creates, 1);
  state.searchVisible = true;
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.creates, 1);
  assert.match(state.comments[0].body, /"state":"linked"/);
});

test('comment update failure after creation recovers the same Jira ticket on retry', async t => {
  const { sync, state } = await setup(t);
  state.commentFailure = true;
  await assert.rejects(sync.issue(state.source, 'opened', []), /HTTP 503/);
  state.commentFailure = false;
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.creates, 1);
  assert.equal(state.comments.length, 1);
});

test('definitive rejected create can be retried after repairing configuration', async t => {
  const { sync, state } = await setup(t);
  state.createFailure = 'rejected';
  await assert.rejects(sync.issue(state.source, 'opened', []), /HTTP 400/);
  state.createFailure = null;
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.tickets.size, 1);
});

test('non-bot comments cannot supply a forged mapping', async t => {
  const { sync, state } = await setup(t);
  state.comments.push({ id: 88, user: { login: 'someone' }, body:
    '<!-- team-ops-jira:{"version":1,"repository":"sw-capstone/bareum-web","number":10,"state":"linked","key":"BRM-99"} -->' });
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.creates, 1);
  assert.equal(state.tickets.has('BRM-99'), false);
});

test('unknown assignee warns without blocking ticket creation or status updates', async t => {
  const { sync, state } = await setup(t);
  state.issue.assignees = [{ login: 'unmapped-user' }];
  state.issue.state = 'closed';
  state.issue.state_reason = 'completed';
  const result = await sync.issue(state.source, 'opened', []);
  assert.deepEqual(result.warnings, [{ code: 'assignee_missing', login: 'unmapped-user' }]);
  assert.equal(state.creates, 1);
  assert.equal(state.comments.length, 1);
  assert.equal(state.tickets.get(result.key).fields.status.id, config.statuses.done);
});

test('cancelled issue wins even when its PR remains ready', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.issue.state = 'closed';
  state.issue.state_reason = 'not_planned';
  state.pulls.push({ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Closes #10' });
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.cancelled);
});

test('insufficient BRM permission fails verification before any writes', async t => {
  const { jira, state } = await setup(t);
  state.permissions = false;
  await assert.rejects(jira.verify(), /missing EDIT_ISSUES/);
  assert.equal(state.requests.filter(request => ['POST', 'PUT', 'PATCH'].includes(request.method)).length, 0);
});
