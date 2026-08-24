const assert = require('node:assert/strict');
const { hasDropCatalogPermission, dropTable, dropView } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;
global.fetch = async (url, init) => {
  request = { url, init };
  return { ok: true, json: async () => ({ id: 'drop-job' }) };
};

(async () => {
  try {
    assert.equal(hasDropCatalogPermission({ permissions: ['DROP'] }), true);
    assert.equal(hasDropCatalogPermission({ permissions: ['OWNERSHIP'] }), true);
    assert.equal(hasDropCatalogPermission({}), false);

    await dropTable({
      url: 'https://dremio.example', token: 'token', direct: true, useTls: true,
    }, ['OpenCatalog', 'namespace', 'table name']);
    assert.equal(request.url, 'https://dremio.example/api/v3/sql');
    assert.equal(request.init.body, JSON.stringify({
      sql: 'DROP TABLE "OpenCatalog"."namespace"."table name"',
    }));

    await dropView({
      url: 'https://dremio.example', token: 'token', direct: true, useTls: true,
    }, ['OpenCatalog', 'namespace', 'view name']);
    assert.equal(request.url, 'https://dremio.example/api/v3/sql');
    assert.equal(request.init.body, JSON.stringify({
      sql: 'DROP VIEW "OpenCatalog"."namespace"."view name"',
    }));
    console.log('Physical tables and virtual datasets use DROP SQL; Dremio enforces authorization.');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
