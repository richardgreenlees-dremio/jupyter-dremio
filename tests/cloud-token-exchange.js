const assert = require('node:assert/strict');
const { ServerConnection } = require('@jupyterlab/services');

const { exchangeCloudPat } = require('../lib/api.js');

const originalMakeSettings = ServerConnection.makeSettings;
const originalMakeRequest = ServerConnection.makeRequest;
let request;

ServerConnection.makeSettings = () => ({ baseUrl: '/user/test/' });
ServerConnection.makeRequest = async (url, init) => {
  request = { url, init };
  return { ok: true, json: async () => ({ token: 'oauth-token' }) };
};

(async () => {
  try {
    assert.equal(await exchangeCloudPat('Bearer cloud-pat', 'eu'), 'oauth-token');
    assert.equal(request.url, '/user/test/dremio/cloud/login');
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.init.body), { pat: 'Bearer cloud-pat', region: 'eu' });
    console.log('Cloud PATs are exchanged through the selected Jupyter Cloud region');
  } finally {
    ServerConnection.makeSettings = originalMakeSettings;
    ServerConnection.makeRequest = originalMakeRequest;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
