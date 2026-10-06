import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { Jira } from '../scripts/lib/jira.mjs';

function setup(types, linkTypes = [{ id: '42', name: 'Relates', inward: '관련', outward: '관련' }], settings = config) {
  const requests = [];
  const jira = new Jira({ async request(path, options = {}) {
    requests.push({ path, method: options.method ?? 'GET' });
    if (path === '/project/BRM') return { key: 'BRM', issueTypes: [] };
    if (path === '/project/BRM/statuses') return types;
    if (path === '/issueLinkType') return { issueLinkTypes: linkTypes };
    if (path.startsWith('/mypermissions?')) {
      const names = new URLSearchParams(path.split('?')[1]).get('permissions').split(',');
      return { permissions: Object.fromEntries(names.map(name => [name, { havePermission: true }])) };
    }
    throw new Error(`Unexpected request: ${path}`);
  } }, settings);
  return { jira, requests };
}

function workflows() {
  return [
    { id: '10037', name: '작업', subtask: false },
    { id: '10036', name: '버그', subtask: false },
    { id: '10034', name: 'Task', subtask: true },
  ].map(type => ({ ...type, statuses: Object.values(config.statuses).map(id => ({ id })) }));
}

test('BRM workflow IDs select Task and Bug despite localized names and empty project issueTypes', async () => {
  const { jira } = setup(workflows());
  assert.equal(await jira.verify(), 'BRM');
  const source = { repository: 'sw-capstone/bareum-web', number: 16 };
  const issue = { title: '[Chore] Jira sync', body: '',
    html_url: 'https://github.com/sw-capstone/bareum-web/issues/16', assignees: [], labels: [] };
  assert.deepEqual(jira.fields(issue, source).issuetype, { id: '10037' });
  issue.labels = [{ name: 'bug' }];
  assert.deepEqual(jira.fields(issue, source).issuetype, { id: '10036' });
});

test('relationship type ID is discovered and no Epic metadata is required', async () => {
  const { jira } = setup(workflows());
  await jira.verify();
  assert.equal(jira.parentLinkType.id, '42');
});

test('missing, ambiguous or asymmetric relationship types fail before writes', async () => {
  const relates = { id: '42', name: 'Relates', inward: 'relates to', outward: 'relates to' };
  for (const types of [[], [relates, { ...relates, id: '43' }], [{ ...relates, outward: 'blocks' }]]) {
    const { jira, requests } = setup(workflows(), types);
    await assert.rejects(jira.verify(), /one symmetric Relates/);
    assert.ok(requests.every(request => request.method === 'GET'));
  }
});

test('a renamed relationship type can be configured without guessing its ID', async () => {
  const { jira } = setup(workflows(), [{ id: '75', name: '관련 작업', inward: '관련', outward: '관련' }],
    { ...config, parentLinkType: '관련 작업' });
  await jira.verify();
  assert.equal(jira.parentLinkType.id, '75');
});

test('Jira summaries identify each repository while preserving the original GitHub title', async () => {
  const { jira } = setup(workflows());
  await jira.verify();
  const issue = { title: '[Chore] Jira 동기화 워크플로 추가', body: '',
    html_url: 'https://github.com/example', assignees: [], labels: [] };
  for (const [repository, alias] of Object.entries(config.repositories)) {
    assert.equal(jira.fields(issue, { repository, number: 16 }).summary,
      `${alias} · [Chore] Jira 동기화 워크플로 추가`);
    assert.equal(issue.title, '[Chore] Jira 동기화 워크플로 추가');
  }
});

test('missing or subtask-only configured types fail verification before any write', async () => {
  for (const id of ['10037', '10036']) {
    for (const subtaskOnly of [false, true]) {
      const types = workflows().flatMap(type => type.id !== id ? [type]
        : subtaskOnly ? [{ ...type, subtask: true }] : []);
      const { jira, requests } = setup(types);
      await assert.rejects(jira.verify(), new RegExp(`issue type ${id} is not available`));
      assert.ok(requests.every(request => request.method === 'GET'));
    }
  }
});
