import { createServer } from 'node:http';
import config from '../config/jira.mjs';
import { HttpClient } from '../scripts/lib/http.mjs';
import { GitHub } from '../scripts/lib/github.mjs';
import { Jira } from '../scripts/lib/jira.mjs';
import { Sync } from '../scripts/lib/sync.mjs';

export async function fixture() {
  const source = { repository: 'sw-capstone/bareum-web', number: 10 };
  const state = {
    source, comments: [], tickets: new Map(), requests: [], creates: 0,
    createFailure: null, commentFailure: false, searchVisible: true,
    issue: {
      number: 10, title: '[Feat] Login', body: 'Acceptance criteria\n- Login works',
      state: 'open', state_reason: null, assignees: [], labels: [],
    },
    pulls: [], permissions: true, assignmentFailures: {}, defaultAssignee: null,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
    state.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    const path = url.pathname;
    if (path === '/_edge/tenant_info') return reply(200, { cloudId: '12345678-1234-1234-1234-123456789abc' });
    if (path === '/oauth/token') return reply(200, { access_token: 'minted-secret', expires_in: 3600 });
    if (path.endsWith('/project/BRM')) return reply(200, {
      key: 'BRM', issueTypes: [],
    });
    if (path.endsWith('/project/BRM/statuses')) return reply(200, [
      { id: config.issueTypes.task, name: 'Task', subtask: false },
      { id: config.issueTypes.bug, name: 'Bug', subtask: false },
    ].map(type => ({ ...type,
      statuses: Object.values(config.statuses).map(id => ({ id })),
    })));
    if (path.endsWith('/mypermissions')) return reply(200, { permissions: Object.fromEntries(
      url.searchParams.get('permissions').split(',').map(name =>
        [name, { havePermission: name === 'EDIT_ISSUES' ? state.permissions : true }]),
    ) });
    if (path.endsWith('/search/jql')) {
      const label = url.searchParams.get('jql').match(/labels = "([^"]+)"/)[1];
      return reply(200, { isLast: true, issues: state.searchVisible
        ? [...state.tickets.values()].filter(ticket => ticket.fields.labels.includes(label)).map(ticket => ({ key: ticket.key })) : [],
      });
    }
    if (path.endsWith('/issue') && req.method === 'POST') {
      state.creates += 1;
      if (state.createFailure === 'rejected') return reply(400, {});
      const key = `BRM-${state.tickets.size + 1}`;
      state.tickets.set(key, {
        key, fields: { ...body.fields, assignee: state.defaultAssignee,
          status: { id: config.statuses.todo }, priority: { name: 'High' },
          sprint: 7, estimate: 5, epic: 'BRM-99' }, source: body.properties[0].value, links: {},
      });
      if (state.createFailure === 'ambiguous') return reply(503, {});
      return reply(201, { key });
    }
    const ticketMatch = path.match(/\/issue\/(BRM-\d+)(?:\/(.*))?$/);
    if (ticketMatch) {
      const ticket = state.tickets.get(ticketMatch[1]);
      if (!ticket) return reply(404, {});
      const suffix = ticketMatch[2];
      if (suffix === 'assignee' && req.method === 'PUT') {
        const failure = state.assignmentFailures[body.accountId ?? 'unassigned'];
        if (failure) return reply(failure, {});
        ticket.fields.assignee = body.accountId ? { accountId: body.accountId } : null;
        return reply(204);
      }
      if (suffix === 'remotelink' && req.method === 'POST') {
        ticket.links[body.globalId] = body.object;
        return reply(201, { id: 1 });
      }
      if (suffix === 'properties/github-source') {
        if (req.method === 'PUT') { ticket.source = body; return reply(200); }
        return ticket.source ? reply(200, { value: ticket.source }) : reply(404, {});
      }
      if (suffix === 'transitions') {
        if (req.method === 'POST') {
          ticket.fields.status = { id: body.transition.id };
          return reply(204);
        }
        return reply(200, { transitions: Object.values(config.statuses).map(id => ({ id, to: { id } })) });
      }
      if (req.method === 'PUT') {
        Object.assign(ticket.fields, body.fields);
        return reply(204);
      }
      return reply(200, ticket);
    }
    if (path === '/graphql') {
      const variables = body.variables;
      const pr = state.pulls.find(item => item.repository === `${variables.owner}/${variables.name}` && item.number === variables.number);
      return reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: {
        nodes: (pr?.closingIssues ?? []).map(ref => ({ number: ref.number, repository: { nameWithOwner: ref.repository } })),
        pageInfo: { hasNextPage: false },
      } } } } });
    }
    const commentEdit = path.match(/\/issues\/comments\/(\d+)$/);
    if (commentEdit && req.method === 'PATCH') {
      if (state.commentFailure) return reply(503, {});
      const comment = state.comments.find(item => item.id === Number(commentEdit[1]));
      comment.body = body.body;
      return reply(200, comment);
    }
    if (path.endsWith('/issues/10/comments')) {
      if (req.method === 'POST') {
        const comment = { id: state.comments.length + 1, body: body.body, user: { login: config.botLogin } };
        state.comments.push(comment);
        return reply(201, comment);
      }
      return reply(200, state.comments);
    }
    if (path.endsWith('/issues/10')) return reply(200, state.issue);
    const pullsMatch = path.match(/\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?$/);
    if (pullsMatch) {
      const pulls = state.pulls.filter(item => item.repository === pullsMatch[1]);
      if (pullsMatch[2]) return reply(200, pulls.find(item => item.number === Number(pullsMatch[2])));
      return reply(200, pulls.filter(item => item.state === 'open'));
    }
    return reply(404, { path });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new HttpClient({ base, token: 'test-secret', service: 'test' });
  const github = new GitHub(client, config);
  const jira = new Jira(client, config);
  await jira.verify();
  return {
    state, github, jira, sync: new Sync({ github, jira, config }), base,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
