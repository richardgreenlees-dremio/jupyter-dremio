const assert = require('node:assert/strict');
const {
  catalogItemKind,
  resolvedCatalogItemKind,
  catalogDeleteLabel,
  canRemoveCatalogItem,
} = require('../lib/api.js');

const item = (overrides) => ({ id: 'id', path: ['root'], ...overrides });

assert.equal(catalogItemKind(item({ isPrimaryCatalog: true, containerType: 'SOURCE' })), 'catalog');
assert.equal(catalogItemKind(item({ containerType: 'SOURCE', sourceType: 'NESSIE' })), 'catalog');
assert.equal(catalogItemKind(item({ containerType: 'SOURCE', sourceType: 'DREMIO_CATALOG_EXTERNAL_V1' })), 'catalog');
assert.equal(catalogItemKind(item({ containerType: 'SOURCE', sourceType: 'DREMIO_CATALOG_EXTERNAL_V2' })), 'catalog');
assert.equal(catalogItemKind(item({ containerType: 'SOURCE', type: 'DREMIO_CATALOG_EXTERNAL_V1' })), 'catalog');
assert.equal(catalogItemKind(item({ entityType: 'source', type: 'NESSIE' })), 'catalog');
assert.equal(catalogItemKind(item({ containerType: 'HOME' })), 'home');
assert.equal(catalogItemKind(item({ containerType: 'SPACE' })), 'space');
assert.equal(catalogItemKind(item({ containerType: 'FOLDER' })), 'folder');
assert.equal(catalogItemKind(item({ containerType: 'FOLDER' }), 'source'), 'source-folder');
assert.equal(catalogItemKind(item({ datasetType: 'PHYSICAL_DATASET' })), 'pds');
assert.equal(catalogItemKind(item({ datasetType: 'VIRTUAL_DATASET' })), 'vds');
assert.equal(catalogItemKind(item({ containerType: 'SOURCE' })), 'source');
assert.equal(catalogItemKind(item({ type: 'FILE' }), 'source-folder'), 'source-file');
assert.equal(catalogItemKind(item({ datasetType: 'PROMOTED', format: { isFolder: true } }), 'source'), 'formatted-source-folder');
assert.equal(catalogItemKind(item({ datasetType: 'PROMOTED', format: { isFolder: false } }), 'source'), 'formatted-source-file');
assert.equal(catalogDeleteLabel(item({ datasetType: 'PROMOTED' })), 'Remove Dataset Format');
assert.equal(catalogDeleteLabel(item({ datasetType: 'PHYSICAL_DATASET' })), 'Drop Table');
assert.equal(catalogDeleteLabel(item({ datasetType: 'VIRTUAL_DATASET' })), 'Drop View');
assert.equal(catalogDeleteLabel(item({ datasetType: 'VIRTUAL' })), 'Drop View');
assert.equal(canRemoveCatalogItem('source-folder', true), false);
assert.equal(canRemoveCatalogItem('source-file', true), false);
assert.equal(canRemoveCatalogItem('pds', true), false);
assert.equal(canRemoveCatalogItem('vds', true), false);
assert.equal(canRemoveCatalogItem('formatted-source-folder', true), true);
assert.equal(canRemoveCatalogItem('formatted-source-file', true), true);
assert.equal(canRemoveCatalogItem('folder', false), true);
assert.equal(canRemoveCatalogItem('pds', false), true);
assert.equal(canRemoveCatalogItem('vds', false), true);
assert.equal(
  resolvedCatalogItemKind(
    item({ containerType: 'FOLDER' }),
    item({ datasetType: 'PROMOTED', format: { isFolder: true } }),
    'source'
  ),
  'source-folder'
);

console.log('Catalog item classification covers all ten display categories and preserves folder icons after expansion.');
