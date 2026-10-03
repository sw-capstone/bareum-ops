import { description, sourceLabel } from './policy.mjs';
import { ApiError } from './http.mjs';

export class Jira {
  constructor(client, config) {
    this.client = client;
    this.config = config;
  }

  async verify() {
    const project = await this.client.request(`/project/${this.config.project}`);
    const workflows = await this.client.request(`/project/${this.config.project}/statuses`);
    if (!Array.isArray(workflows)) throw new Error('Jira issue types unavailable.');
    const statuses = new Set(workflows.flatMap(type => type.statuses.map(status => status.id)));
    for (const id of Object.values(this.config.statuses)) {
      if (!statuses.has(id)) throw new Error(`BRM workflow is missing status ${id}.`);
    }
    const requiredPermissions = [
      'BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'TRANSITION_ISSUES', 'ASSIGN_ISSUES', 'LINK_ISSUES',
    ];
    const permissions = await this.client.request(
      `/mypermissions?projectKey=${this.config.project}&permissions=${requiredPermissions.join(',')}`,
    );
    for (const name of requiredPermissions) {
      if (!permissions.permissions[name]?.havePermission) throw new Error(`Jira bot is missing ${name}.`);
    }
    this.types = workflows;
    for (const id of Object.values(this.config.issueTypes)) {
      if (!this.types.some(type => type.id === id && !type.subtask)) {
        throw new Error(`Jira issue type ${id} is not available in ${this.config.project}.`);
      }
    }
    return project.key;
  }

  issue(key) {
    if (!new RegExp(`^${this.config.project}-[1-9]\\d*$`).test(key)) {
      throw new Error('Invalid Jira issue key.');
    }
    return this.client.request(`/issue/${key}?fields=summary,description,status,assignee,labels,issuetype`);
  }

  async find(source) {
    const params = new URLSearchParams({
      jql: `project = "${this.config.project}" AND labels = "${sourceLabel(source)}"`,
      fields: 'key', maxResults: '2',
    });
    const result = await this.client.request(`/search/jql?${params}`);
    if (!Array.isArray(result.issues)) throw new Error('Unexpected Jira search response.');
    if (result.issues.length > 1 || result.isLast === false) {
      throw new Error('Multiple Jira tickets match this GitHub issue; manual repair required.');
    }
    return result.issues[0]?.key ?? null;
  }

  fields(issue, source) {
    const alias = this.config.repositories[source.repository];
    const logins = issue.assignees.map(user => user.login);
    if (logins.length > 1) {
      throw new Error('Jira supports one assignee; choose one GitHub assignee before syncing.');
    }
    const login = logins[0]?.toLowerCase();
    const accountId = login && Object.hasOwn(this.config.assignees, login)
      ? this.config.assignees[login] : null;
    if (logins.length && !accountId) {
      throw new Error(`Add Jira accountId mapping for GitHub assignee ${logins[0]} in organization variable JIRA_ASSIGNEE_MAP.`);
    }
    const bug = issue.labels.some(label => /\bbug\b/i.test(label.name));
    const typeId = bug ? this.config.issueTypes.bug : this.config.issueTypes.task;
    const type = this.types.find(item => item.id === typeId && !item.subtask);
    if (!type) throw new Error(`Jira issue type ${typeId} is not available in ${this.config.project}.`);
    return {
      summary: issue.title,
      description: description(issue, source, alias),
      assignee: accountId ? { accountId } : null,
      issuetype: { id: type.id },
    };
  }

  create(source, fields) {
    return this.client.request('/issue', { method: 'POST', body: {
      fields: {
        ...fields, project: { key: this.config.project },
        labels: [sourceLabel(source), `repo-${this.config.repositories[source.repository]}`],
      },
      properties: [{ key: 'github-source', value: source }],
    } });
  }

  async update(key, fields, source) {
    const mapped = await this.source(key);
    if (mapped && (mapped.repository !== source.repository || mapped.number !== source.number)) {
      throw new Error('Jira ticket already belongs to a different GitHub issue.');
    }
    const current = await this.issue(key);
    const labels = [...new Set([
      ...current.fields.labels, sourceLabel(source),
      `repo-${this.config.repositories[source.repository]}`,
    ])];
    await this.client.request(`/issue/${key}`, { method: 'PUT', body: {
      fields: { ...fields, labels },
    } });
    await this.client.request(`/issue/${key}/properties/github-source`, {
      method: 'PUT', body: source, expectJson: false,
    });
    await this.link(key, {
      globalId: `github-issue:${source.repository}#${source.number}`,
      url: `https://github.com/${source.repository}/issues/${source.number}`,
      title: `${this.config.repositories[source.repository]}#${source.number}`,
    });
    return current;
  }

  link(key, { globalId, url, title, resolved }) {
    return this.client.request(`/issue/${key}/remotelink`, { method: 'POST', body: {
      globalId, application: { type: 'github', name: 'GitHub' },
      object: { url, title, ...(resolved === undefined ? {} : { status: { resolved } }) },
    } });
  }

  async source(key) {
    await this.issue(key);
    try {
      const result = await this.client.request(`/issue/${key}/properties/github-source`);
      return result.value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async transition(key, target) {
    const current = await this.issue(key);
    if (current.fields.status.id === target) return;
    const result = await this.client.request(`/issue/${key}/transitions`);
    const transition = result.transitions.find(item => item.to.id === target);
    if (!transition) throw new Error(`No permitted transition to status ${target} for ${key}.`);
    await this.client.request(`/issue/${key}/transitions`, {
      method: 'POST', body: { transition: { id: transition.id } },
    });
    const after = await this.issue(key);
    if (after.fields.status.id !== target) throw new Error(`Jira status update did not persist for ${key}.`);
  }
}
