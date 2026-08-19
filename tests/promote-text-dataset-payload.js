const assert = require('node:assert/strict');

const { promoteToTextDataset } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;

global.fetch = async (url, init) => {
  if (!init?.method) {
    return {
      ok: true,
      json: async () => ({
        fileFormat: { location: 'source/data.csv', version: 'format-tag' },
      }),
    };
  }
  assert.equal(url, 'https://dremio.example.com/apiv2/source/source/file_format/data.csv');
  request = init;
  return { ok: true, json: async () => ({}) };
};

(async () => {
  try {
    await promoteToTextDataset(
      { url: 'https://dremio.example.com', token: 'token', direct: true },
      { id: 'dremio:/source/data.csv', path: ['source', 'data.csv'] },
      {
        fieldDelimiter: ',', lineDelimiter: '\r\n', quote: '"', escape: '"',
        extractHeader: true, skipFirstLine: false, trimHeader: true,
      }
    );

    assert.deepEqual(JSON.parse(request.body), {
      location: 'source/data.csv', version: 'format-tag', type: 'Text',
      fieldDelimiter: ',', lineDelimiter: '\r\n', quote: '"', escape: '"',
      extractHeader: true, skipFirstLine: false, trimHeader: true,
    });
    console.log('promoteToTextDataset sends selected text format settings');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
