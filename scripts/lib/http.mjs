import { setTimeout as delay } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(service, status, method, pathname) {
    super(`${service}: ${method} ${pathname} failed (HTTP ${status}).`);
    this.name = 'ApiError';
    this.service = service;
    this.status = status;
    this.method = method;
  }
}

export class HttpClient {
  constructor({ base, token, service, fetcher = fetch }) {
    this.base = new URL(base);
    this.token = token;
    this.service = service;
    this.fetcher = fetcher;
  }

  async request(path, { method = 'GET', body, headers = {}, expectJson = true } = {}) {
    const url = new URL(`${this.base.href.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
    if (url.origin !== this.base.origin) throw new Error('Unexpected API origin.');
    const options = {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetcher(url, {
        ...options, signal: AbortSignal.timeout(30_000),
      });
      // Retry reads only. A timed-out write may already have succeeded remotely.
      if (method === 'GET' && attempt < 2 &&
          (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get('retry-after')) || 2 ** attempt;
        await delay(Math.min(seconds, 30) * 1000);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(this.service, response.status, method, url.pathname);
      }
      if (response.status === 204) return null;
      if (!expectJson) {
        await response.body?.cancel();
        return null;
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`${this.service}: could not read JSON response from ${method} ${url.pathname} (HTTP ${response.status}).`);
      }
    }
  }
}

export async function jiraClient({ site, clientId, clientSecret, fetcher = fetch }) {
  const tenant = new HttpClient({ base: site, service: 'Jira site', fetcher });
  const { cloudId } = await tenant.request('/_edge/tenant_info');
  if (!/^[a-f0-9-]{36}$/i.test(cloudId ?? '')) throw new Error('Invalid Jira cloud ID.');
  const response = await fetcher('https://auth.atlassian.com/oauth/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError('Jira OAuth', response.status, 'POST', '/oauth/token');
  }
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !result.access_token) {
    throw new Error('OAuth response contains no access token.');
  }
  // A minted token is also a secret: mask it before any downstream operation.
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${result.access_token}\n`);
  }
  return new HttpClient({
    base: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
    token: result.access_token, service: 'Jira', fetcher,
  });
}
