import { issueReferences } from './policy.mjs';

export class GitHub {
  constructor(client, config) {
    this.client = client;
    this.config = config;
  }

  async pages(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.client.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Unexpected GitHub pagination response.');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  issue(source) {
    return this.client.request(`/repos/${source.repository}/issues/${source.number}`);
  }

  async pullRequest(source) {
    const pr = await this.client.request(`/repos/${source.repository}/pulls/${source.number}`);
    const [owner, name] = source.repository.split('/');
    const result = await this.client.request('/graphql', { method: 'POST', body: {
      query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) {
          closingIssuesReferences(first:100,after:$cursor) {
            nodes { number repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`,
      variables: { owner, name, number: source.number, cursor: null },
    } });
    if (result.errors?.length) throw new Error('GitHub PR relation lookup failed.');
    const connection = result.data?.repository?.pullRequest?.closingIssuesReferences;
    if (!connection || connection.pageInfo.hasNextPage) {
      throw new Error('PR closing issue links unavailable or exceed 100; refusing a partial sync.');
    }
    return { ...pr, repository: source.repository, closingIssues: connection.nodes.map(node => ({
      repository: node.repository.nameWithOwner, number: node.number,
    })) };
  }

  async openPullRequests() {
    const pulls = [];
    for (const repository of Object.keys(this.config.repositories)) {
      const items = await this.pages(`/repos/${repository}/pulls?state=open`);
      for (const item of items) {
        pulls.push(await this.pullRequest({ repository, number: item.number }));
      }
    }
    return pulls;
  }

  hasReadyPr(source, pulls) {
    return pulls.some(pr => !pr.draft && issueReferences(pr, this.config).some(ref =>
      ref.repository === source.repository && ref.number === source.number));
  }

  comments(source) {
    return this.pages(`/repos/${source.repository}/issues/${source.number}/comments`);
  }

  createComment(source, body) {
    return this.client.request(`/repos/${source.repository}/issues/${source.number}/comments`, {
      method: 'POST', body: { body },
    });
  }

  editComment(source, id, body) {
    return this.client.request(`/repos/${source.repository}/issues/comments/${id}`, {
      method: 'PATCH', body: { body },
    });
  }
}
