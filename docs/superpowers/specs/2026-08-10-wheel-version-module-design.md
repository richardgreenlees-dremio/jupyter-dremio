# Wheel Version Module Design

## Goal

Ensure production wheel builds retain the Python module required to load the Jupyter server extension.

## Design

Keep `jupyter_dremio/_version.py` as a tracked, static version module. Remove it from the frontend clean target so `jlpm build:prod` cannot remove it before `python -m build --wheel` packages the project.

Add a small packaging regression check. It fails if the frontend clean command lists `_version.py` as a deletion target, preventing the known regression before a release build.

## Verification

Build production frontend assets, build a wheel, then inspect the wheel to confirm it contains `_version.py` and imports `jupyter_dremio` in an isolated extraction.
