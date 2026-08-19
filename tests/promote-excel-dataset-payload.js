const assert = require('node:assert/strict');

const { promoteToExcelDataset } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;

global.fetch = async (url, init) => {
  if (!init?.method) {
    return { ok: true, json: async () => ({ fileFormat: { location: 'source/book.xlsx', version: 'format-tag' } }) };
  }
  assert.equal(url, 'https://dremio.example.com/apiv2/source/source/file_format/book.xlsx');
  request = init;
  return { ok: true, json: async () => ({}) };
};

(async () => {
  try {
    await promoteToExcelDataset(
      { url: 'https://dremio.example.com', token: 'token', direct: true },
      { id: 'dremio:/source/book.xlsx', path: ['source', 'book.xlsx'] },
      { sheetName: 'Revenue', extractHeader: true, hasMergedCells: true }
    );

    assert.deepEqual(JSON.parse(request.body), {
      location: 'source/book.xlsx', version: 'format-tag', type: 'Excel',
      sheetName: 'Revenue', extractHeader: true, hasMergedCells: true,
    });
    console.log('promoteToExcelDataset sends selected Excel format settings');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
