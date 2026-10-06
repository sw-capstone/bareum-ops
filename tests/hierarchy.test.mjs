import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { fixture } from './fixture.mjs';
import { eventTarget } from '../scripts/jira-sync.mjs';
import { failureMessage } from '../scripts/notify-failure.mjs';

async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  return f;
}

function addIssue(state, repository, number, labels = []) {
  const source = { repository, number };
  state.extraIssues.set(`${repository}#${number}`, { source, comments: [],
    issue: { number, title: `Work ${number}`, body: 'Completion criteria',
      state: 'open', state_reason: null, assignees: [], labels } });
  return source;
}

function setParent(state, child, parent) {
  const id = `${child.repository}#${child.number}`;
  if (parent) state.parents.set(id, parent);
  else state.parents.delete(id);
}

function manualLink(state, from, to, typeId = '10003') {
  const id = String(state.nextLinkId++);
  state.issueLinks.set(id, { id, typeId, from, to });
  return id;
}

function connected(state, from, to, typeId = '10003') {
  return [...state.issueLinks.values()].filter(link => link.typeId === typeId &&
    [link.from, link.to].includes(from) && [link.from, link.to].includes(to));
}

async function pair(t) {
  const f = await setup(t);
  const child = addIssue(f.state, 'sw-capstone/bareum-ai', 19);
  const parentResult = await f.sync.issue(f.state.source, 'opened', []);
  const childResult = await f.sync.issue(child, 'opened', []);
  setParent(f.state, child, f.state.source);
  return { ...f, child, parentKey: parentResult.key, childKey: childResult.key };
}

test('a GitHub parent stays Task without Epic discovery or Jira parent writes', async t => {
  const { state, sync } = await setup(t);
  const child = addIssue(state, 'sw-capstone/bareum-ai', 19);
  setParent(state, child, state.source);

  const result = await sync.issue(state.source, 'opened', []);

  assert.equal(state.tickets.get(result.key).fields.issuetype.id, config.issueTypes.task);
  assert.equal(state.requests.some(request => request.path.endsWith('/issuetype') || request.path.endsWith('/sub_issues')), false);
  assert.equal(state.requests.some(request => request.body?.fields?.parent || request.body?.update?.parent), false);
});

test('cross-repository children retain independent Task and Bug keys with bidirectional links', async t => {
  const { state, sync, jira } = await setup(t);
  const parent = await sync.issue(state.source, 'opened', []);
  const task = addIssue(state, 'sw-capstone/bareum-ai', 19);
  const bug = addIssue(state, 'sw-capstone/bareum-server', 19, [{ name: 'bug' }]);
  for (const child of [task, bug]) setParent(state, child, state.source);

  const results = await Promise.all([sync.issue(task, 'opened', []), sync.issue(bug, 'opened', [])]);

  assert.notEqual(results[0].key, results[1].key);
  assert.equal(state.tickets.get(parent.key).fields.issuetype.id, config.issueTypes.task);
  assert.equal((await jira.issue(parent.key)).fields.issuelinks.length, 2);
  for (const [index, result] of results.entries()) {
    const ticket = state.tickets.get(result.key);
    assert.equal(ticket.fields.issuetype.id, index === 0 ? config.issueTypes.task : config.issueTypes.bug);
    assert.equal(ticket.fields.parent, undefined);
    const [link] = connected(state, parent.key, result.key);
    assert.equal(ticket.parentLinkRecord.linkId, link.id);
    assert.equal(ticket.parentLinkRecord.owned, true);
  }
  assert.equal(state.creates, 3);
});

test('scheduled scans reconcile links only and repeats perform no writes', async t => {
  const { state, sync, parentKey, childKey } = await pair(t);
  state.tickets.get(parentKey).fields.status.id = config.statuses.progress;
  state.tickets.get(childKey).fields.status.id = config.statuses.review;
  state.tickets.get(childKey).fields.assignee = { accountId: 'owner' };
  state.tickets.get(childKey).fields.sprint = 42;
  const before = [...state.tickets.values()].map(ticket => structuredClone(ticket.fields));
  const offset = state.requests.length;

  assert.deepEqual(await sync.reconcileHierarchy(), [{ source: { repository: 'sw-capstone/bareum-ai', number: 19 }, key: childKey }]);

  assert.deepEqual([...state.tickets.values()].map(ticket => ticket.fields), before);
  assert.equal(state.creates, 2);
  assert.equal(state.requests.slice(offset).some(request =>
    request.path.includes('/pulls') || request.path.endsWith('/assignee') ||
    request.path.endsWith('/transitions') || request.body?.fields), false);
  const repeatOffset = state.requests.length;
  assert.deepEqual(await sync.reconcileHierarchy(), []);
  assert.equal(state.requests.slice(repeatOffset).some(request => request.method !== 'GET'), false);
});

test('moving a child changes only its owned link and preserves keys and sprint', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  await sync.reconcileHierarchy();
  const other = addIssue(state, 'sw-capstone/bareum-server', 8);
  const otherResult = await sync.issue(other, 'opened', []);
  state.tickets.get(childKey).fields.sprint = 42;
  setParent(state, child, other);

  await sync.reconcileHierarchy();

  assert.equal(connected(state, parentKey, childKey).length, 0);
  assert.equal(connected(state, otherResult.key, childKey).length, 1);
  assert.equal(state.tickets.get(childKey).fields.sprint, 42);
  assert.equal(state.creates, 3);
});

test('removing a closed child deletes its link without changing either ticket status or type', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  const issue = state.extraIssues.get(`${child.repository}#${child.number}`).issue;
  issue.state = 'closed';
  issue.state_reason = 'completed';
  await sync.issue(child, 'closed', []);
  setParent(state, child, null);

  await sync.reconcileHierarchy();

  assert.equal(state.issueLinks.size, 0);
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.done);
  assert.equal(state.tickets.get(parentKey).fields.status.id, config.statuses.todo);
  assert.equal(state.tickets.get(parentKey).fields.issuetype.id, config.issueTypes.task);
  assert.deepEqual(state.tickets.get(childKey).parentLinkRecord, { key: null, typeId: null, linkId: null, owned: false });
  assert.deepEqual(await sync.reconcileHierarchy(), []);
});

test('pre-existing manual links in either direction are reused and survive GitHub detachment', async t => {
  for (const reverse of [false, true]) {
    const { state, sync, child, parentKey, childKey } = await pair(t);
    const id = reverse ? manualLink(state, childKey, parentKey) : manualLink(state, parentKey, childKey);

    await sync.reconcileHierarchy();
    assert.equal(state.tickets.get(childKey).parentLinkRecord.owned, false);
    assert.equal(state.issueLinks.size, 1);
    setParent(state, child, null);
    await sync.reconcileHierarchy();
    assert.equal(state.issueLinks.has(id), true);
  }
});

test('unrelated links, other link types and manually assigned Jira Epic parents are preserved', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  state.tickets.get(childKey).fields.parent = { key: 'BRM-99' };
  const related = manualLink(state, childKey, 'BRM-99');
  const blocks = manualLink(state, parentKey, childKey, '10004');
  await sync.issue(child, 'edited', []);
  setParent(state, child, null);

  await sync.reconcileHierarchy();

  assert.equal(state.issueLinks.has(related), true);
  assert.equal(state.issueLinks.has(blocks), true);
  assert.equal(connected(state, parentKey, childKey).length, 0);
  assert.deepEqual(state.tickets.get(childKey).fields.parent, { key: 'BRM-99' });
});

test('a manually recreated link with a different ID is never deleted as the old owned link', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  await sync.reconcileHierarchy();
  const [old] = connected(state, parentKey, childKey);
  state.issueLinks.delete(old.id);
  const replacement = manualLink(state, parentKey, childKey);
  setParent(state, child, null);

  await sync.reconcileHierarchy();

  assert.equal(state.issueLinks.has(replacement), true);
});

test('nested GitHub relationships produce independent adjacent links without recursion', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  const grandchild = addIssue(state, 'sw-capstone/bareum-server', 8);
  await sync.reconcileHierarchy();
  setParent(state, grandchild, child);

  const result = await sync.issue(grandchild, 'opened', []);

  assert.equal(connected(state, parentKey, childKey).length, 1);
  assert.equal(connected(state, childKey, result.key).length, 1);
  assert.ok([...state.tickets.values()].every(ticket => ticket.fields.issuetype.id === config.issueTypes.task));
  assert.equal(state.creates, 3);
});

test('child review, close and reopen never change parent status', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  await sync.reconcileHierarchy();
  state.pulls = [{ repository: child.repository, number: 20, state: 'open', draft: false, body: 'Closes #19' }];
  await sync.pullRequest({ repository: child.repository, number: 20 });
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.review);
  assert.equal(state.tickets.get(parentKey).fields.status.id, config.statuses.todo);
  const issue = state.extraIssues.get(`${child.repository}#${child.number}`).issue;
  issue.state = 'closed';
  issue.state_reason = 'completed';
  await sync.issue(child, 'closed', []);
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.done);
  assert.equal(state.tickets.get(parentKey).fields.status.id, config.statuses.todo);
  issue.state = 'open';
  await sync.issue(child, 'reopened', []);
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.todo);
  assert.equal(state.tickets.get(parentKey).fields.status.id, config.statuses.todo);
});

test('parent closure and reopening leave child status unchanged', async t => {
  const { state, sync, childKey } = await pair(t);
  await sync.reconcileHierarchy();
  state.tickets.get(childKey).fields.status.id = config.statuses.progress;
  state.issue.state = 'closed';
  state.issue.state_reason = 'completed';

  await sync.issue(state.source, 'closed', []);
  assert.equal(state.tickets.get('BRM-1').fields.status.id, config.statuses.done);
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.progress);
  state.issue.state = 'open';
  await sync.issue(state.source, 'reopened', []);
  assert.equal(state.tickets.get(childKey).fields.status.id, config.statuses.progress);
  assert.equal(state.issueLinks.size, 1);
});

test('a missing parent mapping fails the link without creating the parent; retry reuses child', async t => {
  const { state, sync } = await setup(t);
  const child = addIssue(state, 'sw-capstone/bareum-ai', 19);
  setParent(state, child, state.source);

  await assert.rejects(sync.issue(child, 'opened', []), error => error.code === 'mapping_missing');
  assert.equal(state.creates, 1);
  assert.equal(state.tickets.get('BRM-1').source.repository, child.repository);
  const parent = await sync.issue(state.source, 'opened', []);
  const result = await sync.issue(child, 'opened', []);
  assert.equal(result.key, 'BRM-1');
  assert.equal(state.creates, 2);
  assert.equal(connected(state, parent.key, result.key).length, 1);
});

test('scheduled scans skip unsynced issues and never create missing parent tickets', async t => {
  const { state, sync } = await setup(t);
  const child = addIssue(state, 'sw-capstone/bareum-ai', 19);
  assert.deepEqual(await sync.reconcileHierarchy(), []);
  await sync.issue(child, 'opened', []);
  setParent(state, child, state.source);

  await assert.rejects(sync.reconcileHierarchy(), error => error.code === 'mapping_missing');
  assert.equal(state.creates, 1);
});

test('foreign GitHub parents are rejected before ticket writes', async t => {
  const { state, sync } = await setup(t);
  setParent(state, state.source, { repository: 'outside/private', number: 1 });

  await assert.rejects(sync.issue(state.source, 'opened', []), /unavailable repository/);
  assert.equal(state.creates, 0);
});

test('rejected and ambiguous link creation recover without duplicate links or tickets', async t => {
  for (const failure of ['rejected', 'ambiguous']) {
    const { state, sync, child, parentKey, childKey } = await pair(t);
    state.linkCreateFailure = failure;
    await assert.rejects(sync.issue(child, 'edited', []));
    state.linkCreateFailure = null;

    await sync.reconcileHierarchy();

    assert.equal(state.creates, 2);
    assert.equal(connected(state, parentKey, childKey).length, 1);
    assert.equal(state.tickets.get(childKey).parentLinkRecord.owned, true);
    setParent(state, child, null);
    await sync.reconcileHierarchy();
    assert.equal(state.issueLinks.size, 0);
  }
});

test('failed or ambiguous old-link deletion preserves recoverable state during a move', async t => {
  for (const failure of ['rejected', 'ambiguous']) {
    const { state, sync, child, parentKey, childKey } = await pair(t);
    await sync.reconcileHierarchy();
    const other = addIssue(state, 'sw-capstone/bareum-server', 8);
    const target = await sync.issue(other, 'opened', []);
    setParent(state, child, other);
    state.linkDeleteFailure = failure;
    await assert.rejects(sync.reconcileHierarchy());
    state.linkDeleteFailure = null;

    await sync.reconcileHierarchy();

    assert.equal(connected(state, parentKey, childKey).length, 0);
    assert.equal(connected(state, target.key, childKey).length, 1);
    assert.equal(state.creates, 3);
  }
});

test('a manual link added after a definitive creation rejection is not adopted as owned', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);
  state.linkCreateFailure = 'rejected';
  await assert.rejects(sync.reconcileHierarchy());
  state.linkCreateFailure = null;
  const manual = manualLink(state, parentKey, childKey);

  await sync.reconcileHierarchy();
  assert.equal(state.tickets.get(childKey).parentLinkRecord.owned, false);
  setParent(state, child, null);
  await sync.reconcileHierarchy();
  assert.equal(state.issueLinks.has(manual), true);
});

test('rejected and ambiguous ownership writes recover without duplicate links', async t => {
  for (const failure of ['rejected', 'ambiguous']) {
    const { state, sync, parentKey, childKey } = await pair(t);
    state.linkRecordFailure = failure;
    await assert.rejects(sync.reconcileHierarchy());
    assert.equal(state.issueLinks.size, 0);
    state.linkRecordFailure = null;
    await sync.reconcileHierarchy();
    assert.equal(connected(state, parentKey, childKey).length, 1);
  }
});

test('failure saving the confirmed link ID recovers the persisted creation intent', async t => {
  const { state, sync, jira, childKey } = await pair(t);
  const request = jira.client.request.bind(jira.client);
  jira.client.request = async (path, options) => {
    if (options?.method === 'PUT' && path.endsWith('/properties/github-parent-link') && options.body.linkId !== null) {
      state.linkRecordFailure = 'rejected';
    }
    return request(path, options);
  };
  await assert.rejects(sync.reconcileHierarchy());
  assert.equal(state.issueLinks.size, 1);
  assert.equal(state.tickets.get(childKey).parentLinkRecord.linkId, null);
  jira.client.request = request;
  state.linkRecordFailure = null;

  await sync.reconcileHierarchy();

  assert.equal(state.issueLinks.size, 1);
  assert.notEqual(state.tickets.get(childKey).parentLinkRecord.linkId, null);
  assert.deepEqual(await sync.reconcileHierarchy(), []);
});

test('successful responses without creation, deletion or ownership persistence are detected', async t => {
  for (const failure of ['create', 'delete', 'record']) {
    const { state, sync, child } = await pair(t);
    if (failure === 'create') state.linkCreateFailure = 'ignored';
    if (failure === 'record') state.linkRecordFailure = 'ignored';
    if (failure === 'delete') {
      await sync.reconcileHierarchy();
      setParent(state, child, null);
      state.linkDeleteFailure = 'ignored';
    }
    await assert.rejects(sync.reconcileHierarchy(), /did not persist/);
  }
});

test('overlapping normal and scheduled sync converges to one relationship', async t => {
  const { state, sync, child, parentKey, childKey } = await pair(t);

  await Promise.all([sync.issue(child, 'edited', []), sync.reconcileHierarchy()]);
  await sync.reconcileHierarchy();

  assert.equal(connected(state, parentKey, childKey).length, 1);
  assert.equal(state.creates, 2);
});

test('malformed ownership records fail without deleting links', async t => {
  const { state, sync, childKey } = await pair(t);
  state.tickets.get(childKey).parentLinkRecord = { key: 'OTHER-1', typeId: '10003', linkId: '7', owned: true };
  const offset = state.requests.length;

  await assert.rejects(sync.reconcileHierarchy(), /Invalid.*relationship record/);

  assert.equal(state.requests.slice(offset).some(request => request.method !== 'GET'), false);
});

test('GitHub issue enumeration includes closed issues beyond the first page', async t => {
  const { state, github } = await setup(t);
  for (let number = 1; number <= 101; number += 1) addIssue(state, 'sw-capstone/bareum-ai', number);
  state.extraIssues.get('sw-capstone/bareum-ai#101').issue.state = 'closed';

  const sources = await github.issues();

  assert.equal(sources.filter(source => source.repository === 'sw-capstone/bareum-ai').length, 101);
  assert.ok(sources.some(source => source.repository === 'sw-capstone/bareum-ai' && source.number === 101));
});

test('scheduled and manual hierarchy runs do not invent an issue number', () => {
  assert.deepEqual(eventTarget('schedule', {}, {}), { kind: 'hierarchy' });
  assert.deepEqual(eventTarget('workflow_dispatch', {}, { SYNC_MODE: 'hierarchy' }), { kind: 'hierarchy' });
});

test('scheduled failure messages identify relationship reconciliation', () => {
  const message = failureMessage({ GITHUB_REPOSITORY: 'sw-capstone/bareum-ops',
    GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'schedule' }, { schedule: '0 * * * *' });
  assert.match(message, /정기 부모·자식 관계 동기화 중/);
  assert.doesNotMatch(message, /ops · 수동 실행/);
});
