const assert = require('node:assert/strict');

const { promoteToIcebergDataset, promoteToJsonDataset, promoteToParquetDataset } = require('../lib/api.js');

const originalFetch = global.fetch;
const requests = [];

global.fetch = async (_url, init) => {
  if (!init?.method) {
    return { ok: true, json: async () => ({ fileFormat: { location: 'source/data' } }) };
  }
  requests.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({}) };
};

(async () => {
  try {
    const creds = { url: 'https://dremio.example.com', token: 'token', direct: true };
    const item = { id: 'dremio:/source/data', path: ['source', 'data'] };
    await promoteToJsonDataset(creds, item);
    await promoteToParquetDataset(creds, item);
    await promoteToIcebergDataset(creds, item);
    assert.deepEqual(requests, [
      { location: 'source/data', type: 'JSON' },
      { location: 'source/data', type: 'Parquet' },
      { location: 'source/data', type: 'Iceberg' },
    ]);
    console.log('simple dataset promotion sends selected format type');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
