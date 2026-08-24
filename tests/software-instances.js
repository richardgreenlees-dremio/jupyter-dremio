const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ServerConnection } = require('@jupyterlab/services');

const originalMakeSettings = ServerConnection.makeSettings;
const originalMakeRequest = ServerConnection.makeRequest;
let requestUrl;

ServerConnection.makeSettings = () => ({ baseUrl: '/user/test/' });
ServerConnection.makeRequest = async url => {
  requestUrl = url;
  return {
    ok: true,
    json: async () => ({
      instances: [{ id: 'prod', label: 'Dremio Production', url: 'https://dremio.example' }],
    }),
  };
};

(async () => {
  try {
    const { fetchSoftwareInstances } = require('../lib/api.js');
    assert.deepEqual(await fetchSoftwareInstances(), [
      { id: 'prod', label: 'Dremio Production', url: 'https://dremio.example' },
    ]);
    assert.equal(requestUrl, '/user/test/dremio/software/instances');

    const form = fs.readFileSync(path.join(__dirname, '../src/components/LoginForm.tsx'), 'utf8');
    assert.match(form, /softwareInstances\.length === 1/);
    assert.match(form, /softwareInstances\.length > 1/);
    assert.match(form, /softwareInstances\.length === 0/);
    assert.doesNotMatch(form, />Use TLS</);
    assert.match(form, /cleanUrl\.startsWith\('https:\/\/'\)/);
    console.log('Configured Dremio instances replace free-text targets and infer Flight TLS.');
  } finally {
    ServerConnection.makeSettings = originalMakeSettings;
    ServerConnection.makeRequest = originalMakeRequest;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
