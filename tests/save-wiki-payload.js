const assert = require('node:assert/strict');

const { saveWiki } = require('../lib/api.js');

const originalFetch = global.fetch;
let request;

global.fetch = async (_url, init) => {
  request = init;
  return {
    ok: true,
    json: async () => ({ text: '# Updated', version: 3 }),
  };
};

(async () => {
  try {
    const saved = await saveWiki(
      { url: 'https://dremio.example.com', token: 'token', direct: true },
      'catalog-id',
      '# Updated',
      2
    );

    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { text: '# Updated', version: 2 });
    assert.deepEqual(saved, { text: '# Updated', version: 3 });
    console.log('saveWiki sends text and version');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
