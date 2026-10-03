import { ApiError } from './http.mjs';

const marker = /<!-- team-ops-jira:(\{[^\n]*\}) -->/;

function commentBody(record, config) {
  const status = record.key
    ? `Jira: [${record.key}](${config.site}/browse/${record.key})`
    : 'Jira 연결을 준비하고 있습니다. 실패한 경우 Actions 실행을 확인해 주세요.';
  return `${status}\n\n<!-- team-ops-jira:${JSON.stringify(record)} -->`;
}

export class Mapping {
  constructor({ github, jira, config }) {
    this.github = github;
    this.jira = jira;
    this.config = config;
  }

  async record(source) {
    const comments = await this.github.comments(source);
    const matches = comments.filter(comment =>
      comment.user?.login === this.config.botLogin && marker.test(comment.body));
    if (matches.length > 1) throw new Error('Duplicate bot mapping comments; manual repair required.');
    if (!matches.length) return null;
    const comment = matches[0];
    const data = JSON.parse(comment.body.match(marker)[1]);
    if (data.version !== 1 || data.repository !== source.repository || data.number !== source.number ||
        !['pending', 'linked', 'retryable'].includes(data.state)) {
      throw new Error('Invalid bot mapping record; refusing to create a ticket.');
    }
    if (data.state === 'linked' && typeof data.key !== 'string') {
      throw new Error('Linked mapping has no Jira key.');
    }
    return { ...data, commentId: comment.id };
  }

  async save(source, record) {
    const { commentId, ...data } = record;
    const body = commentBody(data, this.config);
    const comment = commentId
      ? await this.github.editComment(source, commentId, body)
      : await this.github.createComment(source, body);
    return { ...data, commentId: comment.id };
  }

  async resolve(source, { create = false, fields } = {}) {
    let record = await this.record(source);
    if (record?.state === 'linked') {
      await this.jira.issue(record.key);
      return record.key;
    }
    const recovered = await this.jira.find(source);
    if (recovered) {
      await this.save(source, {
        version: 1, ...source, commentId: record?.commentId,
        state: 'linked', key: recovered,
      });
      return recovered;
    }
    if (!create) throw new Error('GitHub issue has no Jira mapping yet; run its issue sync first.');
    if (record?.state === 'pending') {
      throw new Error('Previous Jira creation may have succeeded. Retry after search indexing; do not create another ticket.');
    }
    record = await this.save(source, {
      version: 1, ...source, commentId: record?.commentId, state: 'pending', key: null,
    });
    let result;
    try {
      result = await this.jira.create(source, fields);
    } catch (error) {
      // These responses definitively reject the write. Other failures remain pending.
      if (error instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(error.status)) {
        await this.save(source, { ...record, state: 'retryable' });
      }
      throw error;
    }
    await this.jira.issue(result.key);
    await this.save(source, { ...record, state: 'linked', key: result.key });
    return result.key;
  }
}
