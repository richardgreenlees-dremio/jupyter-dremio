const assert = require('node:assert/strict');
const { canWriteCatalogItem } = require('../lib/api.js');

const location = permissions => ({
  id: 'location',
  path: ['Catalog', 'analytics'],
  containerType: 'FOLDER',
  permissions,
});

assert.equal(canWriteCatalogItem(location(['READ', 'CREATE_TABLE'])), true);
assert.equal(canWriteCatalogItem(location(['WRITE'])), true);
assert.equal(canWriteCatalogItem(location(['ALL'])), true);
assert.equal(canWriteCatalogItem(location(['READ'])), false);
assert.equal(canWriteCatalogItem({ ...location(['CREATE_TABLE']), containerType: 'HOME' }), false);

console.log('Save destinations require a writable catalog container.');
