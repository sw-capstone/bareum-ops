import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { fixture } from './fixture.mjs';

async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  return f;
}

test('one closed PR cannot leave review while another ready PR remains linked', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.pulls = [
    { repository: state.source.repository, number: 20, state: 'closed', draft: false, body: 'Closes #10' },
    { repository: state.source.repository, number: 21, state: 'open', draft: false, body: 'Closes #10' },
  ];
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.review);
});

test('draft conversion of the last ready PR returns the issue to progress', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.tickets.get('BRM-1').fields.status.id = config.statuses.review;
  state.pulls = [{ repository: state.source.repository, number: 20, state: 'open', draft: true, body: 'Closes #10' }];
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.progress);
});

test('explicit Jira-only PR link enters review without creating a GitHub issue', async t => {
  const { sync, state } = await setup(t);
  state.tickets.set('BRM-12', { key: 'BRM-12', fields: { status: { id: config.statuses.progress } }, links: {} });
  state.pulls = [{ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Jira: BRM-12' }];
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-12').fields.status.id, config.statuses.review);
  assert.equal(state.comments.length, 0);
  assert.equal(state.creates, 0);
});

test('manual Jira reference to a mapped cancelled issue cannot reopen it', async t => {
  const { sync, state } = await setup(t);
  await sync.issue(state.source, 'opened', []);
  state.issue.state = 'closed';
  state.issue.state_reason = 'not_planned';
  state.pulls = [{ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Jira: BRM-1' }];
  await sync.pullRequest({ repository: state.source.repository, number: 20 });
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.cancelled);
});

test('unmapped linked GitHub issue does not get a ticket just because a PR opened', async t => {
  const { sync, state } = await setup(t);
  state.pulls = [{ repository: state.source.repository, number: 20, state: 'open', draft: false, body: 'Closes #10' }];
  await assert.rejects(sync.pullRequest({ repository: state.source.repository, number: 20 }), /issue sync first/);
  assert.equal(state.creates, 0);
});

test('Jira Bug type follows a GitHub bug label and preserves the GitHub title after the repo prefix', async t => {
  const { sync, state } = await setup(t);
  state.issue.title = '[Bug] Login fails';
  state.issue.labels = [{ name: ':bug: bug' }];
  await sync.issue(state.source, 'opened', []);
  assert.equal(state.tickets.get('BRM-1').fields.issuetype.id, config.issueTypes.bug);
  assert.equal(state.tickets.get('BRM-1').fields.summary, 'web · [Bug] Login fails');
  assert.equal(state.issue.title, '[Bug] Login fails');
});

test('assignee lookup uses an explicit identity mapping', async t => {
  const { jira, state, sync } = await setup(t);
  jira.config = { ...config, assignees: { developer: 'jira-account-123' } };
  state.issue.assignees = [{ login: 'developer' }];
  await sync.issue(state.source, 'opened', []);
  assert.deepEqual(state.tickets.get('BRM-1').fields.assignee, { accountId: 'jira-account-123' });
});
