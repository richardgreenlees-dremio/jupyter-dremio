const assert = require('node:assert/strict');

const { fetchRootCatalog } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;

global.fetch = async (url, init) => {
  request = { url, init };
  return { ok: true, json: async () => ({ data: [] }) };
};

(async () => {
  try {
    await fetchRootCatalog({
      url: 'https://api.dremio.cloud',
      token: 'cloud-token',
      direct: true,
      useTls: true,
      environment: 'cloud-gen1',
      projectId: 'project-id',
    });

    assert.equal(request.url, 'https://api.dremio.cloud/v0/projects/project-id/catalog');
    assert.deepEqual(request.init.headers, { Authorization: 'Bearer cloud-token' });

    await fetchRootCatalog({
      url: 'https://api.eu.dremio.cloud',
      token: 'cloud-token',
      direct: true,
      useTls: true,
      environment: 'cloud-gen2',
      projectId: 'project-id',
      cloudRegion: 'eu',
    });

    assert.equal(request.url, 'https://api.eu.dremio.cloud/v0/projects/project-id/catalog');
    assert.deepEqual(request.init.headers, { Authorization: 'Bearer cloud-token' });
    console.log('Gen1 and Gen2 Cloud catalog requests use region-specific project-scoped Bearer authentication');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
