/**
 * The API client.
 *
 * One place that knows how to talk to the server, so no component ever
 * constructs a URL or a header. Written against fetch rather than axios: the
 * whole surface is a dozen calls, and a dependency would earn its place only if
 * it removed more than it added.
 */

/**
 * In development the Vite proxy forwards /api to the local server, so a
 * relative base keeps the browser on one origin. In production the API is a
 * separate host, and VITE_API_URL supplies it at build time.
 */
const BASE = import.meta.env?.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api`
  : '/api';

/** Tokens live in memory, with the refresh token mirrored to localStorage. */
let accessToken = null;
let refreshToken = localStorage.getItem('attest.refresh') || null;
let onUnauthenticated = () => {};

export function setTokens({ accessToken: access, refreshToken: refresh }) {
  accessToken = access ?? accessToken;
  if (refresh) {
    refreshToken = refresh;
    // Only the refresh token is persisted. The access token stays in memory, so
    // a stolen localStorage payload buys an attacker a token that must be
    // exchanged against the server rather than one that works immediately.
    try {
      localStorage.setItem('attest.refresh', refresh);
    } catch {
      // Private browsing, or storage disabled. The session still works for as
      // long as the tab is open; it simply will not survive a reload.
    }
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  try {
    localStorage.removeItem('attest.refresh');
  } catch {
    /* nothing to clean up */
  }
}

export function hasSession() {
  return Boolean(accessToken || refreshToken);
}

export function onSessionLost(handler) {
  onUnauthenticated = handler;
}

/** An error carrying what the server actually said, for the UI to show. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code;
    this.detail = payload?.error?.detail;
    this.fields = payload?.error?.fields;
    this.requestId = payload?.error?.requestId;
  }
}

async function raw(path, { method = 'GET', body, headers = {}, isForm = false } = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(isForm ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Make a request, refreshing the access token once if it has expired.
 *
 * The retry is deliberately limited to a single attempt on 401: a refresh that
 * itself fails means the session is genuinely over, and looping would turn an
 * expired login into a hammering of the auth endpoint.
 */
async function request(path, options = {}, { retry = true } = {}) {
  let res = await raw(path, options);

  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await raw('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });

    if (refreshed.ok) {
      setTokens(await refreshed.json());
      res = await raw(path, options);
    } else {
      clearTokens();
      onUnauthenticated();
    }
  }

  if (res.status === 204) return null;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) throw new ApiError(res.status, payload);

  // Truncation is reported in headers rather than the body, so it is attached
  // here — a caller must not have to know to look for it.
  const total = res.headers.get('x-total-count');
  if (total !== null && Array.isArray(payload)) {
    Object.defineProperty(payload, 'meta', {
      value: {
        total: Number(total),
        returned: Number(res.headers.get('x-returned-count') ?? payload.length),
        truncated: res.headers.get('x-truncated') === 'true',
      },
      enumerable: false,
    });
  }

  return payload;
}

// ---------------------------------------------------------------------------

export const api = {
  // Auth
  register: (body) => request('/auth/register', { method: 'POST', body }),
  login: (body) => request('/auth/login', { method: 'POST', body }),
  me: () => request('/auth/me'),

  // Clients and periods
  listClients: () => request('/clients'),
  createClient: (body) => request('/clients', { method: 'POST', body }),
  listPeriods: (clientId) => request(`/clients/${clientId}/periods`),
  createPeriod: (clientId, body) =>
    request(`/clients/${clientId}/periods`, { method: 'POST', body }),

  // Documents
  listDocuments: (periodId) => request(`/periods/${periodId}/documents`),
  uploadDocument: (periodId, file, type) => {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    return request(`/periods/${periodId}/documents`, {
      method: 'POST',
      body: form,
      isForm: true,
    });
  },
  periodStatus: (periodId) => request(`/periods/${periodId}/status`),
  sourceUrl: (documentId) => request(`/documents/${documentId}/source-url`),

  // Review
  transactions: (periodId, params = '') => request(`/periods/${periodId}/transactions${params}`),
  reconcile: (periodId) => request(`/periods/${periodId}/reconcile`, { method: 'POST' }),
  flags: (periodId, status) =>
    request(`/periods/${periodId}/flags${status ? `?status=${status}` : ''}`),
  resolveFlag: (flagId, body) => request(`/flags/${flagId}`, { method: 'PATCH', body }),
  vatSummary: (periodId) => request(`/periods/${periodId}/vat-summary`),
};

/**
 * Download an export.
 *
 * Goes through the authenticated client rather than a plain <a href>, because
 * the export route requires a bearer token — a link the browser followed on its
 * own would arrive unauthenticated and 401.
 */
export async function downloadExport(periodId, kind) {
  const res = await raw(`/periods/${periodId}/export/${kind}`, {});
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));

  // The filename the server chose is authoritative — it carries the period
  // label, which is what makes a folder of these tell you anything.
  const disposition = res.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `attest-${kind}.csv`;

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked immediately: the blob holds a client's financial figures, and the
  // download has already been handed to the browser by this point.
  URL.revokeObjectURL(url);
  return filename;
}

/**
 * Fetch a document's original bytes as a blob URL the browser can display.
 *
 * Also authenticated, for the same reason: the content route needs a bearer
 * token, so this cannot be dropped straight into an <iframe src>. A signed link
 * alone is not enough to open a client's bank statement.
 */
export async function fetchSourceBlobUrl(documentId) {
  const { url } = await api.sourceUrl(documentId);
  const res = await raw(url.replace(BASE, ''), {});
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return URL.createObjectURL(await res.blob());
}
