const assert = require('node:assert/strict');

const { saveTags } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;

global.fetch = async (_url, init) => {
  request = init;
  return {
    ok: true,
    json: async () => ({ tags: ['public', 'reference'] }),
  };
};

(async () => {
  try {
    await saveTags(
      { url: 'https://dremio.example.com', token: 'token', direct: true },
      'catalog-id',
      ['public', 'reference']
    );

    assert.deepEqual(JSON.parse(request.body), {
      tags: ['public', 'reference'],
    });
    console.log('saveTags sends raw tag strings');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
