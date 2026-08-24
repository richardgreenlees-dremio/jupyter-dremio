const assert = require('node:assert/strict');
const { submitSql } = require('../lib/api.js');

const originalFetch = global.fetch;
const requests = [];
global.fetch = async (url, init) => {
  requests.push({ url, init });
  return { ok: true, json: async () => ({ id: 'job-id' }) };
};

(async () => {
  try {
    await submitSql({
      url: 'https://dremio.example', token: 'token', direct: true, useTls: true,
    }, 'CREATE TABLE example AS SELECT 1');
    assert.equal(requests[0].url, 'https://dremio.example/api/v3/sql');
    assert.deepEqual(requests[0].init.headers, {
      Authorization: '_dremiotoken', 'Content-Type': 'application/json',
    });

    await submitSql({
      url: 'https://api.dremio.cloud', token: 'cloud-token', direct: true, useTls: true,
      environment: 'cloud-gen2', projectId: 'project-id',
    }, 'CREATE TABLE example AS SELECT 1');
    assert.equal(requests[1].url, 'https://api.dremio.cloud/v0/projects/project-id/sql');
    assert.deepEqual(requests[1].init.headers, {
      Authorization: 'Bearer cloud-token', 'Content-Type': 'application/json',
    });
    console.log('Table SQL is submitted through Dremio REST jobs without Flight result streaming.');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
