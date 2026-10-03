import { createHash } from 'node:crypto';

export function sourceLabel(source) {
  return `gh-${createHash('sha256').update(`${source.repository}#${source.number}`).digest('hex')}`;
}

export function issueReferences(pr, config) {
  const references = new Map();
  const text = `${pr.title ?? ''}\n${pr.body ?? ''}`
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`]*`/g, '');
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:?\s+(?:(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/)|([\w.-]+\/[\w.-]+))?#([1-9]\d*)/gi;
  // URLs use /issues/123 rather than /issues/#123.
  const normalized = text.replace(/(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/)([1-9]\d*)/g, '$1#$2');
  for (const match of normalized.matchAll(pattern)) {
    const repository = match[2] ?? match[3] ?? pr.repository;
    if (Object.hasOwn(config.repositories, repository)) {
      const number = Number(match[4]);
      references.set(`${repository}#${number}`, { repository, number });
    }
  }
  for (const source of pr.closingIssues ?? []) {
    if (Object.hasOwn(config.repositories, source.repository)) {
      references.set(`${source.repository}#${source.number}`, source);
    }
  }
  return [...references.values()];
}

export function manualJiraKeys(pr, project) {
  const pattern = new RegExp(`^\\s*Jira:\\s*(${project}-[1-9]\\d*)\\s*$`, 'gmi');
  return [...new Set([...`${pr.body ?? ''}`.matchAll(pattern)].map(match => match[1].toUpperCase()))];
}

export function desiredStatus({ issue, readyPr, current, reason }, statuses) {
  if (issue.state === 'closed') {
    return issue.state_reason === 'not_planned' ? statuses.cancelled : statuses.done;
  }
  if (readyPr) return statuses.review;
  if ([statuses.done, statuses.cancelled].includes(current)) return statuses.todo;
  if (reason === 'reopened') return statuses.todo;
  if (reason === 'pull_request') return statuses.progress;
  if (current === statuses.review) return statuses.progress;
  return current;
}

export function description(issue, source, alias) {
  const text = issue.body ?? '';
  const paragraphs = text.split(/\r?\n/).map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
  }));
  return { version: 1, type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: `GitHub: ${alias}#${source.number}`, marks: [
        { type: 'link', attrs: { href: `https://github.com/${source.repository}/issues/${source.number}` } },
      ] },
    ] },
    ...paragraphs,
  ] };
}
