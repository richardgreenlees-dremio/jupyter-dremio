# Wheel Version Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure built wheels retain `jupyter_dremio._version` so Jupyter Server can load the proxy extension.

**Architecture:** The static version module remains a source-package file. The frontend clean command removes only generated build output. A regression test asserts that the clean configuration does not delete the version module.

**Tech Stack:** Yarn/JupyterLab build, Hatch wheel packaging, PowerShell validation.

## Global Constraints

- Preserve existing user changes except restoring the deleted tracked version module required by this fix.
- Do not change runtime authentication or API behavior.

---

### Task 1: Protect the version module

**Files:**

- Create: `tests/assert-wheel-version-module.ps1`
- Modify: `package.json`
- Modify: `jupyter_dremio/_version.py`

**Interfaces:**

- Consumes: `package.json` `scripts.clean:labextension` string.
- Produces: a production build that retains `jupyter_dremio/_version.py`.

- [ ] **Step 1: Write the failing regression test**

```powershell
$package = Get-Content package.json -Raw | ConvertFrom-Json
if ($package.scripts.'clean:labextension' -match '_version\\.py') {
  throw 'clean:labextension must not delete jupyter_dremio/_version.py'
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `powershell -ExecutionPolicy Bypass -File tests/assert-wheel-version-module.ps1`

Expected: failure reporting that `clean:labextension` deletes `_version.py`.

- [ ] **Step 3: Apply the minimal packaging fix**

Remove `jupyter_dremio/_version.py` from the JavaScript clean list and restore the tracked file with:

```python
__version__ = "0.1.16"
```

- [ ] **Step 4: Run the regression test to verify it passes**

Run: `powershell -ExecutionPolicy Bypass -File tests/assert-wheel-version-module.ps1`

Expected: exit code 0.

### Task 2: Build and inspect release artifact

**Files:**

- Modify: generated `jupyter_dremio/labextension/`
- Create: generated wheel under `dist/`

**Interfaces:**

- Consumes: corrected clean target and source version module.
- Produces: installable wheel containing `jupyter_dremio/_version.py`.

- [ ] **Step 1: Build frontend assets**

Run: `jlpm build:prod`

Expected: exit code 0 and `_version.py` still exists.

- [ ] **Step 2: Build the wheel**

Run: `python -m build --wheel`

Expected: `dist/jupyter_dremio-0.1.16-py3-none-any.whl`.

- [ ] **Step 3: Inspect wheel content**

Run a ZIP listing and assert it contains `jupyter_dremio/_version.py`.

Expected: exact file present in the wheel.
