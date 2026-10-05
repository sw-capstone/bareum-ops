import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { assigneePlan } from '../scripts/lib/assignees.mjs';
import { fixture } from './fixture.mjs';

const users = [{ login: 'Zeta' }, { login: 'Alpha' }];
const mapping = { zeta: 'account-z', alpha: 'account-a' };

async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  f.jira.config = { ...config, assignees: mapping };
  f.state.issue.assignees = structuredClone(users);
  return f;
}

test('candidate order follows GitHub, retains current owner and deduplicates account aliases', () => {
  assert.deepEqual(assigneePlan(users, mapping).candidates.map(user => user.accountId),
    ['account-z', 'account-a']);
  assert.deepEqual(assigneePlan(users, mapping, 'account-a').candidates.map(user => user.accountId),
    ['account-a', 'account-z']);
  assert.deepEqual(assigneePlan(users, mapping, 'removed').candidates.map(user => user.accountId),
    ['account-z', 'account-a']);
  assert.equal(assigneePlan(users, { zeta: 'same', alpha: 'same' }).candidates.length, 1);
});

test('multiple assignees create one ticket; repeat runs retain the owner and replace participants', async t => {
  const { sync, state } = await setup(t);
  const first = await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get(first.key);
  assert.deepEqual(first.warnings, []);
  assert.equal(ticket.fields.assignee.accountId, 'account-z');
  ticket.fields.assignee = { accountId: 'account-a' };
  await sync.issue(state.source, 'edited', []);
  assert.equal(ticket.fields.assignee.accountId, 'account-a');
  assert.equal(state.creates, 1);
  const text = JSON.stringify(ticket.fields.description);
  assert.equal(text.split('참여자:').length, 2);
  assert.match(text, /참여자: Zeta, Alpha/);
  assert.match(text, /Acceptance criteria/);
  assert.ok(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/issue') ||
    request.method === 'PUT' && /\/issue\/BRM-\d+$/.test(request.path))
    .every(request => !Object.hasOwn(request.body.fields, 'assignee')));
});

test('removing the current owner selects the first remaining user; removing all clears owner and participants', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get('BRM-1');
  state.issue.assignees = [{ login: 'Alpha' }];
  await sync.issue(state.source, 'unassigned', []);
  assert.equal(ticket.fields.assignee.accountId, 'account-a');
  state.issue.assignees = [];
  await sync.issue(state.source, 'unassigned', []);
  assert.equal(ticket.fields.assignee, null);
  assert.doesNotMatch(JSON.stringify(ticket.fields.description), /참여자:/);
});

test('Jira-only clearing is restored from GitHub on the next sync', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get('BRM-1');
  ticket.fields.assignee = null;
  await sync.issue(state.source, 'edited', []);
  assert.equal(ticket.fields.assignee.accountId, 'account-z');
});

test('initial unassigned and all-unmapped issues clear a Jira default owner', async t => {
  for (const assignees of [[], [{ login: 'Unknown' }]]) {
    const { sync, state } = await setup(t);
    state.defaultAssignee = { accountId: 'default-owner' };
    state.issue.assignees = assignees;
    const result = await sync.issue(state.source, 'opened', []);
    assert.equal(state.tickets.get(result.key).fields.assignee, null);
    assert.equal(result.warnings.length, assignees.length);
  }
});

test('unmapped first user is skipped while every participant is displayed', async t => {
  const { sync, state, jira } = await setup(t);
  jira.config = { ...jira.config, assignees: { alpha: mapping.alpha } };
  const result = await sync.issue(state.source, 'opened', []);
  assert.equal(state.tickets.get(result.key).fields.assignee.accountId, 'account-a');
  assert.deepEqual(result.warnings, [{ code: 'assignee_missing', login: 'Zeta' }]);
  assert.match(JSON.stringify(state.tickets.get(result.key).fields.description), /Zeta, Alpha/);
});

test('isolated assignment rejections fall back without losing metadata or terminal status', async t => {
  for (const status of [400, 403, 422]) {
    const { sync, state } = await setup(t);
    state.assignmentFailures['account-z'] = status;
    state.issue.state = 'closed';
    state.issue.state_reason = 'not_planned';
    const result = await sync.issue(state.source, 'edited', []);
    const ticket = state.tickets.get(result.key);
    assert.equal(ticket.fields.assignee.accountId, 'account-a');
    assert.equal(ticket.fields.status.id, config.statuses.cancelled);
    assert.equal(ticket.fields.summary, 'web · [Feat] Login');
    assert.deepEqual(result.warnings, [{ code: 'assignee_rejected', login: 'Zeta' }]);
  }
});

test('all candidates rejected clears a former owner and still completes the closed ticket', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get('BRM-1');
  ticket.fields.assignee = { accountId: 'former-owner' };
  state.assignmentFailures = { 'account-z': 400, 'account-a': 400 };
  state.issue.state = 'closed';
  state.issue.state_reason = 'completed';
  const result = await sync.issue(state.source, 'edited', []);
  assert.equal(ticket.fields.assignee, null);
  assert.equal(ticket.fields.status.id, config.statuses.done);
  assert.equal(result.warnings.length, 2);
});

test('rejected clearing keeps other updates and explicitly warns that the old owner remains', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  const ticket = state.tickets.get('BRM-1');
  state.issue.assignees = [];
  state.issue.title = 'Updated title';
  state.assignmentFailures.unassigned = 400;
  const result = await sync.issue(state.source, 'unassigned', []);
  assert.equal(ticket.fields.summary, 'web · Updated title');
  assert.equal(ticket.fields.assignee.accountId, 'account-z');
  assert.deepEqual(result.warnings, [{ code: 'assignee_clear_rejected' }]);
});

test('assignment authentication, missing issue and service errors still fail after core sync', async t => {
  for (const status of [401, 404, 429, 503]) {
    const { sync, state } = await setup(t);
    state.assignmentFailures['account-z'] = status;
    state.issue.state = 'closed';
    state.issue.state_reason = 'completed';
    await assert.rejects(sync.issue(state.source, 'closed', []), new RegExp(`HTTP ${status}`));
    assert.equal(state.creates, 1);
    assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.done);
    assert.equal(state.requests.filter(request => request.path.endsWith('/assignee')).length, 1);
  }
});
