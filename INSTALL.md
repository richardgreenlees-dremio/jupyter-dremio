# Install & Development Guide

## Prerequisites

- Python ≥ 3.8
- JupyterLab 4.x
- Node.js ≥ 18 *(only needed for the development install — not required when installing from the wheel)*

---

## Installation options

| Option | When to use | Node.js required? |
|--------|-------------|-------------------|
| [A — Install from wheel](#a--install-from-the-pre-built-wheel) | End users; quickest path; no build tools needed | No |
| [B — Development install](#b--development-install-editable) | Contributors who want to edit TypeScript and reload live | Yes |
| [C — Direct mode (frontend only)](#direct-mode-no-server-extension) | Managed JupyterHub where you cannot install server-side packages | No |

---

## A — Install from the pre-built wheel

A pre-built wheel is included in `dist/`. This is the quickest way to install
the extension — no Node.js, npm, or jlpm needed.

```bash
pip install dist/jupyter_dremio-0.1.0-py3-none-any.whl --forece-install --no-deps
```

### JupyterHub / shared environment

If you do not have write access to the base environment, activate your own
conda environment first:

```bash
conda activate my-env
pip install /path/to/jupyter_dremio-0.1.0-py3-none-any.whl --forece-install --no-deps
```

### Verify the wheel install

After installing, confirm that both the frontend and server-side parts are
registered before starting JupyterLab:

```bash
jupyter labextension list
# expected:  jupyter-dremio v0.1.0 enabled OK

jupyter server extension list
# expected:  jupyter_dremio enabled ... OK
```

If the server extension is missing, enable it manually:

```bash
jupyter server extension enable --py jupyter_dremio
```

Then start JupyterLab:

```bash
jupyter lab
```

The Dremio icon appears in the left sidebar. See
[Verifying the installation](#verifying-the-installation) for full details
on each check and how to fix common problems.

---

## B — Development install (editable)

---

## Installing Node.js and npm (Anaconda / JupyterHub)

If you are using Anaconda or a JupyterHub environment and `node` / `npm` are not available, install them through `conda` rather than a system package manager. This keeps Node inside your conda environment and avoids permission issues.

```bash
# Verify that Node is missing first
node --version   # should print "command not found" if not installed
npm  --version   # same

# Install Node.js ≥ 18 from the conda-forge channel into the active environment
conda install -c conda-forge nodejs

# Confirm the installation
node --version   # e.g. v20.x.x
npm  --version   # e.g. 10.x.x
```

If you need a specific Node version (e.g. 18 LTS):

```bash
conda install -c conda-forge "nodejs>=18,<19"
```

> **JupyterHub multi-user deployments** — if you do not have write access to the shared base environment, activate (or create) a personal conda environment first:
>
> ```bash
> conda create -n dremio-ext python=3.11
> conda activate dremio-ext
> conda install -c conda-forge nodejs jupyterlab
> ```
>
> Then follow the development-install steps below inside that environment.

---

## B — Development install (editable)

```bash
# 1. Enter the project directory
cd JupyterHubExt

# 2. Install JupyterLab and every build tool into your active environment.
#    All packages must be in the same environment because --no-build-isolation
#    (step 4) skips pip's temporary build env and uses this one directly.
#    jupyterlab also provides the jlpm command.
pip install jupyterlab hatchling hatch-nodejs-version hatch-jupyter-builder editables

# 3. Install Node dependencies.
#    .yarnrc.yml (included in the repo) sets nodeLinker: node-modules so Yarn
#    writes a plain node_modules/ folder instead of a Plug'n'Play .pnp.cjs
#    file. This is necessary because different jlpm versions cannot read each
#    other's .pnp.cjs files, which would break step 4.
jlpm install

# 4. Install the Python package in editable mode.
#    --no-build-isolation uses the current environment (with node_modules/
#    already in place) instead of a fresh temporary one. This step also
#    compiles the TypeScript and bundles the labextension automatically.
pip install -e ".[dev]" --no-build-isolation

# 5. Register the labextension with JupyterLab.
#    This creates a symlink from JupyterLab's extensions directory to the
#    built files so JupyterLab can find the extension on startup.
jupyter labextension develop --overwrite .

# 6. Watch for TypeScript changes and rebuild automatically (optional,
#    open a second terminal for this)
jlpm watch
```

Then start JupyterLab:

```bash
jupyter lab
```

The Dremio icon (table-grid) will appear in the left sidebar, just below
the file-browser folder icon.

---

## Verifying the installation

Run the checks below **before** starting JupyterLab to confirm that both the
frontend and server-side parts of the extension are registered correctly.

### 1 — Frontend (labextension)

```bash
jupyter labextension list
```

Expected output contains:

```
jupyter-dremio v0.1.0 enabled OK
```

`enabled` means the extension is registered with JupyterLab.  
`OK` means the built assets were found and are loadable.

If `jupyter-dremio` is missing entirely, the Python package was not installed
or the labextension symlink was not created. Re-run step 5 of the development
install:

```bash
jupyter labextension develop --overwrite .
```

If the package appears but shows `disabled`, enable it explicitly:

```bash
jupyter labextension enable jupyter-dremio
```

---

### 2 — Server-side extension

```bash
jupyter server extension list
```

Expected output contains:

```
jupyter_dremio enabled
    - Validating jupyter_dremio...
      jupyter_dremio  OK
```

`enabled` means Jupyter Server will load the extension's Tornado handlers
(`/dremio/*` routes) at startup.  
`OK` means the module was imported successfully and the handler setup passed
validation.

If `jupyter_dremio` does not appear, the Python package is installed but the
server extension entry point was not discovered. Enable it manually:

```bash
jupyter server extension enable --py jupyter_dremio
```

If the extension appears but shows `disabled`:

```bash
jupyter server extension enable --py jupyter_dremio
```

If the extension shows a Python import error, verify that the package is
installed in the same environment as `jupyter`:

```bash
pip show jupyter-dremio       # should show Name, Location, etc.
python -c "import jupyter_dremio; print('import OK')"
```

---

### 3 — Quick combined check

```bash
jupyter labextension list && jupyter server extension list
```

A fully working installation produces **two** `OK` lines — one for the
frontend bundle and one for the server-side handlers:

```
JupyterLab extensions:
jupyter-dremio v0.1.0 enabled OK

...

jupyter_dremio enabled
    - Validating jupyter_dremio...
      jupyter_dremio  OK
```

If only the labextension is `OK` but the server extension is missing or
disabled, the panel will still load but will fall back to **direct mode**
(see the *Direct mode* section below).

---

## Production build

```bash
jlpm build:prod
pip install .
```

---

## Rebuilding the wheel

After making TypeScript changes, regenerate the wheel before distributing:

```bash
jlpm build:prod           # compile & bundle TypeScript
python -m build --wheel   # package into dist/
```

---

## Direct mode (no server extension)

If you cannot install the Python server extension (e.g. a managed JupyterHub
where you only control your own pip packages), the extension detects this
automatically and switches to **direct mode**.

In direct mode:
- The browser calls Dremio's REST API directly instead of going through the
  Jupyter proxy (`/dremio/*` handlers are never used).
- No `pip install` of the Python package is required on the server — you only
  need the JupyterLab frontend extension registered.
- **SSO / Kerberos is not available** (it requires the server-side Python handler).
- **Dremio must allow CORS** from the JupyterHub origin. Ask your Dremio
  administrator to add the JupyterHub host to Dremio's allowed origins, or check
  whether your Dremio version already allows it.

The mode is shown as a small **"direct"** badge in the panel footer when active.

### Installing the frontend extension only (direct mode, no server changes)

```bash
# Install just the labextension assets — no server-side handlers
pip install dist/jupyter_dremio-0.1.0-py3-none-any.whl

# The Python server extension is optional; if the /dremio/* routes are absent,
# the panel automatically falls back to direct mode.
```

---

## How it works

| Layer | What it does |
|-------|-------------|
| **Python server extension** (`jupyter_dremio/handlers.py`) | Tornado request handlers that proxy Dremio REST API calls. Runs inside the Jupyter Server process so there are no CORS issues. |
| **TypeScript plugin** (`src/index.ts`) | Registers a left-sidebar panel (rank 200, just below Files at rank 100) using the JupyterLab extension API. |
| **React UI** (`src/components/`) | Login form → toolbar → lazy-loading tree. Each tree node calls the proxy when expanded. |

---

## OpenID Connect SSO

The plugin supports any provider that implements OpenID Connect Authorization Code Flow with PKCE, including Microsoft Entra ID, Okta, Keycloak, and Authentik. The Jupyter server obtains an external JWT and exchanges it through Dremio Software's configured **External Token Provider** at `/oauth/token`.

First configure the Dremio Software instances users may connect to:

```powershell
$env:JUPYTER_DREMIO_SOFTWARE_INSTANCES = @'
[
  {"id": "prod", "label": "Dremio Production", "url": "https://dremio.example.com"}
]
'@
```

One configured instance is displayed read-only on the login screen. Multiple instances produce a dropdown. If this variable is absent, the login screen retains the free-text Dremio URL field for backward compatibility. Flight SQL TLS is inferred from `https://`.

Configure one or more named providers in the Jupyter server environment. Secrets must be supplied by the administrator, never entered in the sidebar:

```powershell
$env:JUPYTER_DREMIO_OIDC_PROVIDERS = @'
{
  "entra": {
    "label": "Microsoft Entra ID",
    "issuer": "https://login.microsoftonline.com/TENANT_ID/v2.0",
    "client_id": "CLIENT_ID",
    "client_secret": "CLIENT_SECRET",
    "scopes": "openid profile email api://DREMIO_APP_ID/dremio",
    "username_claim": "preferred_username",
    "dremio_urls": ["https://dremio.example.com"]
  },
  "okta": {
    "label": "Okta",
    "issuer": "https://example.okta.com/oauth2/default",
    "client_id": "CLIENT_ID",
    "client_secret": "CLIENT_SECRET",
    "scopes": "openid profile email dremio",
    "username_claim": "preferred_username",
    "dremio_urls": ["https://dremio.example.com"]
  }
}
'@
```

Provider entries also accept `token_endpoint_auth_method` (`client_secret_basic`, `client_secret_post`, or `none`), `authorization_params`, and `id_token_algorithms`. The default signing algorithm is `RS256`. Public clients may omit `client_secret` and select `none`. OIDC Dremio targets are allowlisted by `dremio_urls`, a shared comma-separated `JUPYTER_DREMIO_ALLOWED_URLS`, or the configured `JUPYTER_DREMIO_SOFTWARE_INSTANCES`. This prevents an external JWT from being sent to a user-selected server.

If Jupyter is behind a reverse proxy, explicitly configure the callback URL registered with every provider:

```powershell
$env:JUPYTER_DREMIO_OIDC_REDIRECT_URI = "https://jupyter.example.com/user/USER/dremio/oidc/callback"
```

The provider must issue a JWT access token whose `iss`, `aud`, and username claim match a Dremio Software External Token Provider. Console SSO configuration alone is not sufficient. The plugin validates the ID token, keeps the external and Dremio tokens server-side, and gives the browser only an opaque session handle. OIDC requires HTTPS unless `JUPYTER_DREMIO_OIDC_ALLOW_INSECURE_HTTP=1` is explicitly set for local development.

Process-local sessions suit the normal one-Jupyter-server-process-per-user deployment. A deployment running multiple web workers must replace the in-memory session dictionaries with a shared TTL store before enabling OIDC.

For a single provider, the shorter `JUPYTER_DREMIO_OIDC_ISSUER`, `JUPYTER_DREMIO_OIDC_CLIENT_ID`, `JUPYTER_DREMIO_OIDC_CLIENT_SECRET`, `JUPYTER_DREMIO_OIDC_SCOPES`, and `JUPYTER_DREMIO_OIDC_USERNAME_CLAIM` variables are also supported.

---

## Kerberos / Windows Active Directory login

The separate **Sign in with Kerberos** option authenticates through Kerberos/SPNEGO, preserving Windows Integrated Authentication deployments.

### Requirements

1. **Install `requests-kerberos`** on the Jupyter server:

   ```bash
   pip install requests-kerberos
   ```

2. **The Jupyter server must have a valid Kerberos context.** In practice this means one of:
   - Running on a Windows machine that is joined to the AD domain (the service account's ticket is used automatically).
   - Running on Linux with a Kerberos keytab configured for the service account (`KRB5_KTNAME` env var or `/etc/krb5.keytab`).

3. **Dremio must be configured for Kerberos/SPNEGO authentication.** This is set up by the Dremio administrator in Dremio's security settings.

If `requests-kerberos` is not installed, or if the Kerberos context is not available, the Kerberos button returns a clear error message. Users can always fall back to OIDC or username/password login.

---

## Dremio API calls proxied

| Frontend route | Dremio endpoint | Purpose |
|----------------|-----------------|---------|
| `POST /dremio/login` | `POST /apiv2/login` | Authenticate (username/password) |
| `GET /dremio/oidc/providers` | OIDC discovery configuration | List configured OIDC providers |
| `POST /dremio/oidc/start` | Provider authorization endpoint | Start OIDC with PKCE |
| `GET /dremio/oidc/callback` | Provider token endpoint, then `POST /oauth/token` | Complete OIDC and Dremio token exchange |
| `POST /dremio/sso-login` | `GET /api/v3/catalog` (Kerberos probe) | Authenticate via Kerberos |
| `POST /dremio/sso-logout` | *(server-side session clear)* | Sign out SSO session |
| `GET /dremio/catalog` | `GET /api/v3/catalog` | Root catalog |
| `GET /dremio/catalog/{id}` | `GET /api/v3/catalog/{id}` | Children |
| `DELETE /dremio/catalog/{id}` | `DELETE /api/v3/catalog/{id}` | Delete item |
| `POST /dremio/catalog/folder` | `POST /api/v3/catalog` | Create folder |
| `GET /dremio/wiki/{id}` | `GET /api/v3/catalog/{id}/wiki` | Fetch wiki / description for an item |

---

## Wiki & metadata

Right-clicking any node in the catalog tree opens a context menu with two options:

- **Open wiki** — fetches the Dremio wiki page for that item and renders it as Markdown in a panel in the main area. The panel is a singleton: clicking "Open wiki" on a different item replaces the content in the same tab rather than opening a new one.
- **Copy path to clipboard** — copies the fully-quoted SQL path (e.g. `"MySpace"."Schema"."Table"`) to the clipboard, ready to paste into a query editor.

Wiki content is rendered from the Markdown stored in Dremio's catalog wiki field (`/api/v3/catalog/{id}/wiki`). If no wiki has been written for an item, the panel shows a placeholder message.

---

## Drag-and-drop

Drag any catalog node (table, view, folder, space) and drop it onto a
notebook code cell.

- **Dataset** → inserts `SELECT * FROM "Schema"."Table" LIMIT 100`
- **Container** → inserts the quoted SQL path `"Space"."Folder"`
