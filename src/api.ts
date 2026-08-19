import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DremioEnvironment = 'software' | 'cloud-gen1' | 'cloud-gen2';
export type DremioCloudRegion = 'us' | 'eu';

export interface DremioCredentials {
  url: string;
  token: string;
  /** true = browser calls Dremio directly (no Jupyter server extension needed) */
  direct: boolean;
  username?: string;
  /** kept in memory for the session lifetime so notebooks can be pre-wired */
  password?: string;
  /** Use TLS when creating an Arrow Flight SQL connection. */
  useTls: boolean;
  environment?: DremioEnvironment;
  /** Required by Dremio Cloud REST APIs. */
  projectId?: string;
  /** Dremio Cloud control plane. */
  cloudRegion?: DremioCloudRegion;
}

export type CatalogEntityType = 'CONTAINER' | 'DATASET' | 'FILE';
export type ContainerSubType = 'SPACE' | 'SOURCE' | 'FOLDER' | 'HOME';
export type DatasetSubType = 'VIRTUAL_DATASET' | 'PHYSICAL_DATASET' | 'PROMOTED';

export interface ColumnField {
  name: string;
  type: { name: string };
}

export interface CatalogItem {
  id: string;
  path: string[];
  tag?: string;
  entityType?: CatalogEntityType;
  type?: CatalogEntityType | ContainerSubType | DatasetSubType;
  containerType?: ContainerSubType;
  datasetType?: DatasetSubType;
  children?: CatalogItem[];
  fields?: ColumnField[];
  format?: { isFolder?: boolean };
}

export interface CatalogRoot {
  data: CatalogItem[];
}

export interface LoginResponse {
  token: string;
  userName: string;
}

export interface WikiContent {
  text: string | null;
  version?: number;
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the Jupyter server has the dremio proxy extension installed.
 * A non-404 response (e.g. 401) means the handler exists.
 */
export async function detectServerExtension(): Promise<boolean> {
  try {
    const settings = ServerConnection.makeSettings();
    const url = URLExt.join(settings.baseUrl, 'dremio/catalog');
    const resp = await fetch(url);
    return resp.status !== 404;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proxy mode helpers (browser → Jupyter server → Dremio)
// ---------------------------------------------------------------------------

function proxyHeaders(creds: DremioCredentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Dremio-URL': creds.url,
    'X-Dremio-Token': creds.token,
  };
}

async function proxyRequest(path: string, init: RequestInit): Promise<any> {
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(settings.baseUrl, path);
  const response = await ServerConnection.makeRequest(fullUrl, init, settings);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Direct mode helpers (browser → Dremio directly, requires Dremio CORS config)
// ---------------------------------------------------------------------------

function directAuthHeader(token: string): Record<string, string> {
  return { Authorization: `_dremio${token}` };
}

interface CloudLoginResponse {
  token: string;
}

function isCloud(creds: DremioCredentials): boolean {
  return creds.environment === 'cloud-gen1' || creds.environment === 'cloud-gen2';
}

function cloudApiUrl(creds: DremioCredentials, path: string): string {
  if (!creds.projectId) throw new Error('A Dremio Cloud Project ID is required.');
  return `${creds.url.replace(/\/$/, '')}/v0/projects/${encodeURIComponent(creds.projectId)}/${path}`;
}

function requestAuthHeader(creds: DremioCredentials): Record<string, string> {
  return isCloud(creds)
    ? { Authorization: `Bearer ${creds.token}` }
    : directAuthHeader(creds.token);
}

async function directRequest(url: string, init: RequestInit): Promise<any> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Public API — each function routes on the direct flag
// ---------------------------------------------------------------------------

export async function login(
  dremioUrl: string,
  username: string,
  password: string,
  direct: boolean
): Promise<LoginResponse> {
  if (direct) {
    // Dremio's own REST endpoint — note: field is "userName", not "username"
    return directRequest(`${dremioUrl}/apiv2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: username, password }),
    });
  }
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(settings.baseUrl, 'dremio/login');
  const response = await ServerConnection.makeRequest(
    fullUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dremio-URL': dremioUrl },
      body: JSON.stringify({ username, password }),
    },
    settings
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login failed (${response.status}): ${text}`);
  }
  return response.json();
}

/** SSO login is only available in proxy mode (requires server-side Kerberos). */
export async function ssoLogin(dremioUrl: string): Promise<LoginResponse> {
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(settings.baseUrl, 'dremio/sso-login');
  const response = await ServerConnection.makeRequest(
    fullUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dremio-URL': dremioUrl },
    },
    settings
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SSO login failed (${response.status}): ${text}`);
  }
  return response.json();
}

export async function ssoLogout(dremioUrl: string): Promise<void> {
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(settings.baseUrl, 'dremio/sso-logout');
  await ServerConnection.makeRequest(
    fullUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dremio-URL': dremioUrl } },
    settings
  );
}

export async function fetchRootCatalog(creds: DremioCredentials): Promise<CatalogRoot> {
  if (isCloud(creds)) {
    return directRequest(cloudApiUrl(creds, 'catalog'), { headers: requestAuthHeader(creds) });
  }
  if (creds.direct) {
    return directRequest(`${creds.url}/api/v3/catalog`, {
      headers: directAuthHeader(creds.token),
    });
  }
  return proxyRequest('dremio/catalog', {
    method: 'GET',
    headers: proxyHeaders(creds),
  });
}

export async function fetchCatalogItem(
  creds: DremioCredentials,
  id: string
): Promise<CatalogItem> {
  if (isCloud(creds)) {
    return directRequest(cloudApiUrl(creds, `catalog/${encodeURIComponent(id)}`), {
      headers: requestAuthHeader(creds),
    });
  }
  if (creds.direct) {
    return directRequest(`${creds.url}/api/v3/catalog/${encodeURIComponent(id)}`, {
      headers: directAuthHeader(creds.token),
    });
  }
  return proxyRequest(`dremio/catalog/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: proxyHeaders(creds),
  });
}

export async function deleteCatalogItem(
  creds: DremioCredentials,
  id: string
): Promise<void> {
  if (creds.direct) {
    const resp = await fetch(`${creds.url}/api/v3/catalog/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: directAuthHeader(creds.token),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Delete failed (${resp.status}): ${text}`);
    }
    return;
  }
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(
    settings.baseUrl,
    `dremio/catalog/${encodeURIComponent(id)}`
  );
  const response = await ServerConnection.makeRequest(
    fullUrl,
    { method: 'DELETE', headers: proxyHeaders(creds) },
    settings
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Delete failed (${response.status}): ${text}`);
  }
}

export async function createFolder(
  creds: DremioCredentials,
  path: string[]
): Promise<CatalogItem> {
  if (creds.direct) {
    return directRequest(`${creds.url}/api/v3/catalog`, {
      method: 'POST',
      headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'folder', path }),
    });
  }
  return proxyRequest('dremio/catalog/folder', {
    method: 'POST',
    headers: proxyHeaders(creds),
    body: JSON.stringify({ path }),
  });
}

export async function fetchWiki(
  creds: DremioCredentials,
  id: string
): Promise<WikiContent> {
  if (creds.direct) {
    const resp = await fetch(
      `${creds.url}/api/v3/catalog/${encodeURIComponent(id)}/collaboration/wiki`,
      { headers: directAuthHeader(creds.token) }
    );
    if (resp.status === 404) return { text: null };
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json();
  }
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(
    settings.baseUrl,
    `dremio/wiki/${encodeURIComponent(id)}`
  );
  const response = await ServerConnection.makeRequest(
    fullUrl,
    { method: 'GET', headers: proxyHeaders(creds) },
    settings
  );
  if (response.status === 404) return { text: null };
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return response.json();
}

export async function saveWiki(
  creds: DremioCredentials,
  id: string,
  text: string,
  version?: number
): Promise<WikiContent> {
  const body: Record<string, unknown> = { text };
  if (version != null) body.version = version;

  if (creds.direct) {
    return directRequest(
      `${creds.url}/api/v3/catalog/${encodeURIComponent(id)}/collaboration/wiki`,
      {
        method: 'POST',
        headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
  }
  return proxyRequest(`dremio/wiki/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: proxyHeaders(creds),
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobItem {
  id: string;
  state: string;
  user: string;
  startedAt?: string;
  endedAt?: string;
  queryType?: string;
  requestType?: string;
  datasetPathList?: string[];
  acceleration?: boolean;
  description?: string;
  rowCount?: number;
  outputRecordCount?: number;
  resourceSchedulingInfo?: {
    resourceSchedulingStart?: string;
    resourceSchedulingEnd?: string;
    queueName?: string;
    queueId?: string;
  };
  durationDetails?: Array<{ phase: string; duration: number }>;
}

export interface JobsResponse {
  data: JobItem[];
  total?: number;
}

export async function fetchJobs(
  creds: DremioCredentials,
  limit = 200
): Promise<JobsResponse> {
  const qs = `sort=START_TIME&order=DESCENDING&limit=${limit}&offset=0`;
  if (creds.direct) {
    const resp = await fetch(`${creds.url}/api/v3/jobs?${qs}`, {
      headers: directAuthHeader(creds.token),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json();
  }
  return proxyRequest(`dremio/jobs?${qs}`, {
    method: 'GET',
    headers: proxyHeaders(creds),
  });
}

export interface TextDatasetFormat {
  fieldDelimiter: string;
  lineDelimiter: string;
  quote: string;
  escape: string;
  extractHeader: boolean;
  skipFirstLine: boolean;
  trimHeader: boolean;
}

interface FileFormatResponse {
  fileFormat?: Record<string, unknown>;
  [key: string]: unknown;
}

type FormatTarget = 'file' | 'folder';

function fileFormatEndpoint(item: CatalogItem, target: FormatTarget): string {
  if (item.path.length < 2) {
    throw new Error('A source file path is required to register a text dataset.');
  }
  const [source, ...filePath] = item.path;
  return `source/${encodeURIComponent(source)}/${target}_format/${filePath.map(encodeURIComponent).join('/')}`;
}

async function fetchFileFormat(
  creds: DremioCredentials,
  item: CatalogItem,
  target: FormatTarget
): Promise<FileFormatResponse> {
  const endpoint = fileFormatEndpoint(item, target);
  if (creds.direct) {
    return directRequest(`${creds.url}/apiv2/${endpoint}`, {
      headers: directAuthHeader(creds.token),
    });
  }
  return proxyRequest(`dremio/${target}-format/${item.path.map(encodeURIComponent).join('/')}`, {
    method: 'GET',
    headers: proxyHeaders(creds),
  });
}

export async function fetchFormatStatus(
  creds: DremioCredentials,
  item: CatalogItem,
  isFolder: boolean
): Promise<boolean> {
  const response = await fetchFileFormat(creds, item, isFolder ? 'folder' : 'file');
  const format = response.fileFormat ?? response;
  return typeof format.version === 'string' && format.version.length > 0;
}

async function promoteToSimpleFileDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  type: 'JSON' | 'Parquet' | 'Iceberg',
  target: FormatTarget
): Promise<CatalogItem> {
  const current = await fetchFileFormat(creds, item, target);
  const body = { ...(current.fileFormat ?? current), type };
  const endpoint = fileFormatEndpoint(item, target);
  if (creds.direct) {
    return directRequest(`${creds.url}/apiv2/${endpoint}`, {
      method: 'PUT',
      headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return proxyRequest(`dremio/${target}-format/${item.path.map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: proxyHeaders(creds),
    body: JSON.stringify(body),
  });
}

export function promoteToParquetDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  isFolder = false
): Promise<CatalogItem> {
  return promoteToSimpleFileDataset(creds, item, 'Parquet', isFolder ? 'folder' : 'file');
}

/** Exchange a Dremio Cloud PAT for the short-lived Bearer token used by Cloud APIs. */
export async function exchangeCloudPat(pat: string, region: DremioCloudRegion = 'us'): Promise<string> {
  const data = await proxyRequest('dremio/cloud/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pat, region }),
  });
  const { token } = data as CloudLoginResponse;
  if (!token) throw new Error('Cloud token exchange did not return an access token.');
  return token;
}

export function promoteToJsonDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  isFolder = false
): Promise<CatalogItem> {
  return promoteToSimpleFileDataset(creds, item, 'JSON', isFolder ? 'folder' : 'file');
}

export function promoteToIcebergDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  isFolder = false
): Promise<CatalogItem> {
  return promoteToSimpleFileDataset(creds, item, 'Iceberg', isFolder ? 'folder' : 'file');
}

export async function promoteToTextDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  format: TextDatasetFormat,
  isFolder = false
): Promise<CatalogItem> {
  // Raw files use Dremio's v2 source file-format endpoint, not Catalog v3.
  // Preserve Dremio's current location and version fields from its format.
  const target: FormatTarget = isFolder ? 'folder' : 'file';
  const current = await fetchFileFormat(creds, item, target);
  const currentFormat = current.fileFormat ?? current;
  const body = {
    ...currentFormat,
    type: 'Text',
    ...format,
  };
  const endpoint = fileFormatEndpoint(item, target);
  if (creds.direct) {
    return directRequest(`${creds.url}/apiv2/${endpoint}`, {
      method: 'PUT',
      headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return proxyRequest(`dremio/${target}-format/${item.path.map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: proxyHeaders(creds),
    body: JSON.stringify(body),
  });
}

export interface ExcelDatasetFormat {
  sheetName: string;
  extractHeader: boolean;
  hasMergedCells: boolean;
}

export async function promoteToExcelDataset(
  creds: DremioCredentials,
  item: CatalogItem,
  format: ExcelDatasetFormat,
  isFolder = false
): Promise<CatalogItem> {
  const target: FormatTarget = isFolder ? 'folder' : 'file';
  const current = await fetchFileFormat(creds, item, target);
  const currentFormat = current.fileFormat ?? current;
  const body = {
    ...currentFormat,
    type: 'Excel',
    ...format,
  };
  const endpoint = fileFormatEndpoint(item, target);
  if (creds.direct) {
    return directRequest(`${creds.url}/apiv2/${endpoint}`, {
      method: 'PUT',
      headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return proxyRequest(`dremio/${target}-format/${item.path.map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: proxyHeaders(creds),
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Search — POST /api/v3/search
// ---------------------------------------------------------------------------

// Per Dremio docs: each result has a "category" and a "catalogObject" sub-object.
interface SearchCatalogObject {
  id?: string;
  path?: string[];
  tag?: string;
  [key: string]: unknown;
}

interface SearchResult {
  category?: string;            // TABLE | VIEW | FOLDER | SPACE | SOURCE | …
  catalogObject?: SearchCatalogObject;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DremioSearchResponse = Record<string, any>;

function normaliseSearchResult(result: SearchResult): CatalogItem | null {
  const obj = result.catalogObject;
  if (!obj) return null;                    // job / script / reflection — skip
  const path: string[] = (obj.path as string[] | undefined) ?? [];
  if (!path.length) return null;

  // Map the "category" string to the type fields the rest of the UI expects
  let entityType: CatalogEntityType | undefined;
  let containerType: ContainerSubType | undefined;
  let datasetType: DatasetSubType | undefined;

  switch (result.category) {
    case 'TABLE':
      entityType = 'DATASET'; datasetType = 'PHYSICAL_DATASET'; break;
    case 'VIEW':
      entityType = 'DATASET'; datasetType = 'VIRTUAL_DATASET'; break;
    case 'FOLDER':
      entityType = 'CONTAINER'; containerType = 'FOLDER'; break;
    case 'SPACE':
      entityType = 'CONTAINER'; containerType = 'SPACE'; break;
    case 'SOURCE':
      entityType = 'CONTAINER'; containerType = 'SOURCE'; break;
    default:
      entityType = 'CONTAINER';
  }

  // Dremio search results often omit the UUID id field. We use a 'path:' prefix
  // as a sentinel so the backend knows to call /api/v3/catalog/by-path/... instead
  // of /api/v3/catalog/{uuid}. This is always safe — by-path works for any item.
  const id = `path:${path.join('/')}`;

  return {
    id,
    path,
    entityType,
    type: entityType,
    containerType,
    datasetType,
    tag: obj.tag as string | undefined,
  };
}

export async function fetchCatalogSearch(
  creds: DremioCredentials,
  q: string,
  maxResults = 50
): Promise<CatalogRoot & { _rawKeys?: string }> {
  let raw: DremioSearchResponse;
  if (creds.direct) {
    raw = await directRequest(`${creds.url}/api/v3/search`, {
      method: 'POST',
      headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q,
        filter: 'category in ["TABLE", "VIEW"]',
        pageToken: '',
        maxResults,
      }),
    });
  } else {
    raw = await proxyRequest(
      `dremio/catalog/search?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
      { method: 'GET', headers: proxyHeaders(creds) }
    );
  }
  const hits: SearchResult[] = raw.results ?? [];
  const items = hits.map(normaliseSearchResult).filter((x): x is CatalogItem => x !== null);
  return { data: items, _rawKeys: Object.keys(raw).join(', ') };
}

// ---------------------------------------------------------------------------
// Tags  — GET/POST /api/v3/catalog/{id}/collaboration/tag
// ---------------------------------------------------------------------------

export interface TagsContent {
  tags: string[];
  version?: string;
}

// Dremio returns tags as [{name:"..."}, ...] or as plain strings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseTags(data: any): TagsContent {
  const raw: unknown[] = Array.isArray(data?.tags) ? data.tags : [];
  const tags = raw
    .map(t => (typeof t === 'string' ? t : (t as { name?: string }).name ?? ''))
    .filter(Boolean);
  return { tags, version: data?.version };
}

async function resolveUuidDirect(creds: DremioCredentials, id: string): Promise<string> {
  if (!id.startsWith('path:')) return id;
  const segments = id.slice(5).split('/');
  const encodedPath = segments.map(s => encodeURIComponent(s)).join('/');
  const detail = await directRequest(`${creds.url}/api/v3/catalog/by-path/${encodedPath}`, {
    headers: directAuthHeader(creds.token),
  });
  return (detail as { id?: string }).id ?? id;
}

export async function fetchTags(
  creds: DremioCredentials,
  id: string
): Promise<TagsContent> {
  if (creds.direct) {
    const resolvedId = await resolveUuidDirect(creds, id);
    const resp = await fetch(
      `${creds.url}/api/v3/catalog/${encodeURIComponent(resolvedId)}/collaboration/tag`,
      { headers: directAuthHeader(creds.token) }
    );
    if (resp.status === 404) return { tags: [] };
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return normaliseTags(await resp.json());
  }
  const settings = ServerConnection.makeSettings();
  const fullUrl = URLExt.join(settings.baseUrl, `dremio/tags/${encodeURIComponent(id)}`);
  const response = await ServerConnection.makeRequest(
    fullUrl,
    { method: 'GET', headers: proxyHeaders(creds) },
    settings
  );
  if (response.status === 404) return { tags: [] };
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return normaliseTags(await response.json());
}

export async function saveTags(
  creds: DremioCredentials,
  id: string,
  tags: string[],
  version?: string
): Promise<TagsContent> {
  const body: Record<string, unknown> = {
    tags,
  };
  if (version != null) body.version = version;

  if (creds.direct) {
    const resolvedId = await resolveUuidDirect(creds, id);
    const data = await directRequest(
      `${creds.url}/api/v3/catalog/${encodeURIComponent(resolvedId)}/collaboration/tag`,
      {
        method: 'POST',
        headers: { ...directAuthHeader(creds.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return normaliseTags(data);
  }
  const data = await proxyRequest(`dremio/tags/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: proxyHeaders(creds),
    body: JSON.stringify(body),
  });
  return normaliseTags(data);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function buildSqlPath(path: string[]): string {
  return path.map(p => `"${p}"`).join('.');
}

export function isDataset(item: CatalogItem): boolean {
  return item.entityType === 'DATASET' || item.type === 'DATASET';
}

export function isFile(item: CatalogItem): boolean {
  return item.entityType === 'FILE' || item.type === 'FILE';
}

export function isContainer(item: CatalogItem): boolean {
  return (
    item.entityType === 'CONTAINER' ||
    item.type === 'CONTAINER' ||
    item.containerType != null
  );
}

export function itemIcon(item: CatalogItem): string {
  const sub = item.containerType ?? item.type;
  switch (sub) {
    case 'HOME':             return '🏠';
    case 'SPACE':            return '📦';
    case 'SOURCE':           return '🗄️';
    case 'FOLDER':           return (isDataset(item)) ? '🗃️' : '📁';
    case 'VIRTUAL_DATASET':  return '👁️';
    case 'PHYSICAL_DATASET': return '🗃️';
    default:                 return '📄';
  }
}
