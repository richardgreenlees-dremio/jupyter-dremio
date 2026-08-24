const assert = require('node:assert/strict');
const { CellRunTracker, isDremioSqlCell } = require('../lib/cellJobStatus.js');

assert.equal(isDremioSqlCell('%%sql\nSELECT 1'), true);
assert.equal(isDremioSqlCell('%sql SELECT 1'), true);
assert.equal(isDremioSqlCell('result = %sql SELECT 1'), true);
assert.equal(isDremioSqlCell('print("not sql")'), false);

const tracker = new CellRunTracker();
const cell = {};

tracker.start(cell);
assert.equal(tracker.finish(cell), true);

tracker.start(cell);
tracker.start(cell);
assert.equal(tracker.finish(cell), false);
assert.equal(tracker.finish(cell), true);
assert.equal(tracker.finish(cell), false);

console.log('Cell job status tracks only the newest Dremio SQL execution.');
