import { appendFile } from 'node:fs/promises';
import { ApiError } from './http.mjs';

export class SyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.details = details;
  }
}

export const failureCodes = Object.freeze([
  'mapping_missing', 'mapping_pending',
  'permission', 'configuration', 'authentication', 'temporary_api', 'api', 'unknown',
]);
const codes = new Set(failureCodes);
const repositories = new Set([
  'sw-capstone/bareum-web', 'sw-capstone/bareum-server',
  'sw-capstone/bareum-ai', 'sw-capstone/bareum-ops',
]);

export function safeFailure(value) {
  const result = { version: 1, code: codes.has(value?.code) ? value.code : 'unknown' };
  const source = value?.source;
  if (repositories.has(source?.repository) && Number.isSafeInteger(source.number) && source.number > 0) {
    result.source = { repository: source.repository, number: source.number };
  }
  if (typeof value?.login === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.login)) {
    result.login = value.login;
  }
  if (['GitHub', 'Jira', 'Jira site', 'Jira OAuth'].includes(value?.service)) result.service = value.service;
  if (Number.isInteger(value?.status) && value.status >= 400 && value.status <= 599) result.status = value.status;
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value?.method)) result.method = value.method;
  return result;
}

export function describeFailure(error) {
  if (error instanceof SyncError) return safeFailure({ code: error.code, ...error.details });
  if (error instanceof ApiError) {
    const code = error.status === 401 ? 'authentication' : error.status === 403 ? 'permission'
      : error.status === 429 || error.status >= 500 ? 'temporary_api' : 'api';
    return safeFailure({ code, service: error.service, status: error.status, method: error.method });
  }
  return safeFailure({ code: 'unknown' });
}

export async function recordFailure(error, environment) {
  const failure = describeFailure(error);
  if (environment.GITHUB_OUTPUT) {
    await appendFile(environment.GITHUB_OUTPUT, `failure=${JSON.stringify(failure)}\n`);
  }
  return failure;
}
