import { issueReferences, manualJiraKeys, desiredStatus } from './policy.mjs';
import { Mapping } from './mapping.mjs';
import { SyncError } from './failure.mjs';

export class Sync {
  constructor({ github, jira, config }) {
    this.github = github;
    this.jira = jira;
    this.config = config;
    this.mapping = new Mapping({ github, jira, config });
  }

  validateSource(source) {
    if (!Object.hasOwn(this.config.repositories, source.repository) ||
        !Number.isSafeInteger(source.number) || source.number < 1) {
      throw new Error('Repository or issue number is not allowed.');
    }
  }

  async issue(source, reason, pulls, create = true) {
    this.validateSource(source);
    const issue = await this.github.issue(source);
    if (issue.pull_request) throw new Error('A pull request number is not an issue number.');
    const parent = await this.github.parent(source);
    const fields = this.jira.fields(issue, source);
    const key = await this.mapping.resolve(source, { create, fields });
    const current = await this.jira.update(key, fields, source);
    // Fetch again after metadata writes, so a concurrent close has priority over a PR.
    const latest = await this.github.issue(source);
    const status = desiredStatus({
      issue: latest, current: current.fields.status.id, reason,
      readyPr: this.github.hasReadyPr(source, pulls) || pulls.some(pr =>
        !pr.draft && manualJiraKeys(pr, this.config.project).includes(key)),
    }, this.config.statuses);
    await this.jira.transition(key, status);
    const warnings = await this.jira.syncAssignee(key, issue.assignees, current.fields.assignee?.accountId);
    const parentKey = parent ? await this.mapping.resolve(parent) : null;
    await this.jira.syncParentLink(key, parentKey);
    return { source, key, status, warnings };
  }

  async reconcileHierarchy() {
    const sources = await this.github.issues();
    const entries = [];
    for (const source of sources) {
      this.validateSource(source);
      let key;
      try {
        key = await this.mapping.resolve(source);
      } catch (error) {
        if (!(error instanceof SyncError) || error.code !== 'mapping_missing') throw error;
        continue;
      }
      const parent = await this.github.parent(source);
      entries.push({ source, parent, key });
    }
    const results = [];
    for (const { source, parent, key } of entries) {
      const mappedParent = parent && entries.find(entry =>
        entry.source.repository === parent.repository && entry.source.number === parent.number);
      if (parent && !mappedParent) {
        throw new SyncError('mapping_missing', 'GitHub parent issue has no Jira mapping; run its issue sync first.', { source: parent });
      }
      if (await this.jira.syncParentLink(key, mappedParent?.key ?? null)) results.push({ source, key });
    }
    return results;
  }

  async pullRequest(source, previousBody) {
    this.validateSource(source);
    const pr = await this.github.pullRequest(source);
    const pulls = await this.github.openPullRequests();
    const refs = new Map();
    for (const version of [pr, { ...pr, body: previousBody ?? pr.body }]) {
      for (const ref of issueReferences(version, this.config)) {
        refs.set(`${ref.repository}#${ref.number}`, ref);
      }
    }
    const results = [];
    for (const ref of refs.values()) {
      results.push(await this.issue(ref, 'pull_request', pulls, false));
    }
    const mappedKeys = new Set(results.map(result => result.key));
    for (const key of new Set([
      ...manualJiraKeys(pr, this.config.project),
      ...manualJiraKeys({ body: previousBody }, this.config.project),
    ])) {
      if (mappedKeys.has(key)) continue;
      const linkedSource = await this.jira.source(key);
      if (linkedSource) {
        results.push(await this.issue(linkedSource, 'pull_request', pulls, false));
        continue;
      }
      const current = await this.jira.issue(key);
      const terminal = [this.config.statuses.done, this.config.statuses.cancelled];
      if (terminal.includes(current.fields.status.id)) {
        results.push({ key, status: current.fields.status.id });
        continue;
      }
      const ready = pulls.some(item => !item.draft && manualJiraKeys(item, this.config.project).includes(key));
      const status = ready ? this.config.statuses.review : this.config.statuses.progress;
      await this.jira.transition(key, status);
      results.push({ key, status });
    }
    for (const key of new Set(results.map(result => result.key))) {
      const phase = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
      await this.jira.link(key, {
        globalId: `github-pr:${source.repository}#${source.number}`,
        url: `https://github.com/${source.repository}/pull/${source.number}`,
        title: `PR ${this.config.repositories[source.repository]}#${source.number} (${phase})`,
        resolved: pr.state === 'closed',
      });
    }
    return results;
  }
}
