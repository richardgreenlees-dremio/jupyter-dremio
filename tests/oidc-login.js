const assert = require('node:assert/strict');
const { ServerConnection } = require('@jupyterlab/services');

const originalMakeSettings = ServerConnection.makeSettings;
const originalMakeRequest = ServerConnection.makeRequest;
const originalWindow = global.window;
const requests = [];
let popupClosed = false;

global.window = {
  open: () => ({
    document: { title: '', body: { textContent: '' } },
    location: { href: '' },
    get closed() { return popupClosed; },
    close: () => { popupClosed = true; },
  }),
  setTimeout,
};

ServerConnection.makeSettings = () => ({ baseUrl: '/user/test/' });
ServerConnection.makeRequest = async (url, init) => {
  requests.push({ url, init });
  if (url.endsWith('/dremio/oidc/providers')) {
    return { ok: true, json: async () => ({ providers: [{ id: 'entra', label: 'Microsoft Entra ID' }] }) };
  }
  if (url.endsWith('/dremio/oidc/start')) {
    return { ok: true, json: async () => ({ authorizationUrl: 'https://idp.example/authorize', transactionId: 'tx-1' }) };
  }
  if (url.endsWith('/dremio/oidc/status/tx-1')) {
    return { ok: true, json: async () => ({ status: 'complete', token: '__sso__:session', userName: 'alice', authType: 'oidc' }) };
  }
  if (url.endsWith('/dremio/auth/flight-token')) {
    return { ok: true, json: async () => ({ authorizationHeader: 'Bearer dremio-token' }) };
  }
  if (url.endsWith('/dremio/sso-logout')) {
    return { ok: true, json: async () => ({}) };
  }
  throw new Error(`Unexpected request: ${url}`);
};

(async () => {
  try {
    const {
      fetchFlightAuthorizationHeader,
      fetchOidcProviders,
      oidcLogin,
      ssoLogout,
    } = require('../lib/api.js');

    assert.deepEqual(await fetchOidcProviders(), [{ id: 'entra', label: 'Microsoft Entra ID' }]);
    const login = await oidcLogin('https://dremio.example', 'entra');
    assert.equal(login.token, '__sso__:session');
    assert.equal(popupClosed, true);

    const start = requests.find(request => request.url.endsWith('/dremio/oidc/start'));
    assert.equal(start.init.headers['X-Dremio-URL'], 'https://dremio.example');
    assert.deepEqual(JSON.parse(start.init.body), { provider: 'entra' });

    const creds = {
      url: 'https://dremio.example',
      token: '__sso__:session',
      direct: false,
      useTls: true,
      authType: 'oidc',
    };
    assert.equal(await fetchFlightAuthorizationHeader(creds), 'Bearer dremio-token');
    await ssoLogout(creds);
    const logout = requests.find(request => request.url.endsWith('/dremio/sso-logout'));
    assert.equal(logout.init.headers['X-Dremio-Token'], '__sso__:session');
    console.log('OIDC login keeps the Dremio token server-side and preserves SSO logout');
  } finally {
    ServerConnection.makeSettings = originalMakeSettings;
    ServerConnection.makeRequest = originalMakeRequest;
    global.window = originalWindow;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
