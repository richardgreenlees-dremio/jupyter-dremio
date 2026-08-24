const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const form = fs.readFileSync(path.join(__dirname, '../src/components/LoginForm.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../style/index.css'), 'utf8');

assert.match(form, /OIDC SSO is not configured on this Jupyter server/);
assert.match(form, /aria-describedby="dremio-oidc-help-tooltip"/);
assert.match(form, /JUPYTER_DREMIO_OIDC_PROVIDERS/);
assert.match(form, /External Token Provider/);
assert.match(form, /role="tooltip"/);
assert.match(form, /onClick=\{\(\) => setShowOidcHelp/);
assert.match(css, /\.dremio-oidc-help:hover \.dremio-oidc-help-tooltip/);
assert.match(css, /\.dremio-oidc-help:focus-within \.dremio-oidc-help-tooltip/);
assert.match(css, /\.dremio-oidc-help--open \.dremio-oidc-help-tooltip/);

console.log('Unconfigured OIDC notice exposes hover, focus, and click setup help.');
