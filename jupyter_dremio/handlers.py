import json
import secrets
import urllib.parse

import requests
from jupyter_server.base.handlers import APIHandler
from tornado import web

# In-memory store for SSO sessions: session_id -> dremio_token
_sso_sessions: dict[str, str] = {}


def _dremio_url(handler: APIHandler) -> str:
    url = handler.request.headers.get("X-Dremio-URL", "").rstrip("/")
    if not url:
        raise web.HTTPError(400, "Missing X-Dremio-URL header")
    return url


def _dremio_token(handler: APIHandler) -> str:
    raw = handler.request.headers.get("X-Dremio-Token", "")
    if raw.startswith("__sso__:"):
        session_id = raw[len("__sso__:"):]
        token = _sso_sessions.get(session_id)
        if not token:
            raise web.HTTPError(401, "SSO session expired or not found")
        return token
    return raw


def _auth_header(token: str) -> dict:
    return {"Authorization": f"_dremio{token}"}


class LoginHandler(APIHandler):
    @web.authenticated
    def post(self):
        dremio_url = _dremio_url(self)
        body = json.loads(self.request.body)
        username = body.get("username", "")
        password = body.get("password", "")
        resp = requests.post(
            f"{dremio_url}/apiv2/login",
            json={"userName": username, "password": password},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


class SsoLoginHandler(APIHandler):
    @web.authenticated
    def post(self):
        dremio_url = _dremio_url(self)

        try:
            from requests_kerberos import HTTPKerberosAuth, OPTIONAL as KRB_OPTIONAL
        except ImportError:
            raise web.HTTPError(
                501,
                "requests-kerberos is not installed on the Jupyter server. "
                "Ask your administrator to run: pip install requests-kerberos[kerberos]",
            )

        # ── Step 1: probe whether the server advertises Negotiate/Kerberos auth ──
        try:
            probe = requests.get(
                f"{dremio_url}/apiv2/login",
                timeout=10,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise web.HTTPError(503, f"Cannot reach Dremio at {dremio_url}: {exc}")

        www_auth = probe.headers.get("WWW-Authenticate", "")
        if probe.status_code in (401, 403) and "Negotiate" not in www_auth:
            raise web.HTTPError(
                401,
                "This Dremio server does not support Kerberos/SPNEGO authentication "
                "(no 'WWW-Authenticate: Negotiate' header in the server response). "
                "Your organisation likely uses LDAP or SAML — please use the "
                "'Use username & password' option to log in with your normal credentials.",
            )

        # ── Step 2: attempt Kerberos authentication ────────────────────────────
        try:
            resp = requests.get(
                f"{dremio_url}/api/v3/catalog",
                auth=HTTPKerberosAuth(mutual_authentication=KRB_OPTIONAL),
                timeout=30,
            )
        except Exception as exc:
            # The Kerberos library itself raised — typically means no ticket or
            # the KRB5 environment is not configured.
            raise web.HTTPError(
                401,
                f"Kerberos library error: {exc}. "
                "On Windows: make sure you are logged in to a domain-joined machine. "
                "On Linux/Mac: run 'kinit your@DOMAIN' in a terminal first.",
            )

        if resp.status_code == 401:
            raise web.HTTPError(
                401,
                "Kerberos ticket was presented but Dremio rejected it. "
                "Check that your ticket is for the correct realm and that the "
                "Dremio service principal (HTTP/dremio.host@REALM) is registered. "
                "On Linux/Mac try 'kinit' again; on Windows re-lock and unlock your session.",
            )

        if not resp.ok:
            raise web.HTTPError(resp.status_code, f"Kerberos auth failed: {resp.text or '(no body)'}")

        # ── Step 3: extract Dremio token from the response ─────────────────────
        token = (
            resp.headers.get("_dremio_token")
            or resp.headers.get("Authorization", "").removeprefix("_dremio")
        )
        if not token:
            try:
                data = resp.json()
                token = data.get("token", "")
            except Exception:
                pass

        if not token:
            raise web.HTTPError(502, "Kerberos auth succeeded but no Dremio token was returned.")

        session_id = secrets.token_hex(16)
        _sso_sessions[session_id] = token

        # ── Step 4: resolve the username ───────────────────────────────────────
        user_name = "sso-user"
        user_resp = requests.get(
            f"{dremio_url}/api/v3/catalog",
            headers=_auth_header(token),
            timeout=30,
        )
        if user_resp.ok:
            d = user_resp.json()
            user_name = d.get("username") or d.get("userName") or user_name

        self.finish({"token": f"__sso__:{session_id}", "userName": user_name})


class SsoLogoutHandler(APIHandler):
    @web.authenticated
    def post(self):
        raw = self.request.headers.get("X-Dremio-Token", "")
        if raw.startswith("__sso__:"):
            session_id = raw[len("__sso__:"):]
            _sso_sessions.pop(session_id, None)
        self.finish({})


class RootCatalogHandler(APIHandler):
    @web.authenticated
    def get(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        resp = requests.get(
            f"{dremio_url}/api/v3/catalog",
            headers=_auth_header(token),
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


def _catalog_url(dremio_url: str, item_id: str) -> str:
    """Return the correct Dremio catalog URL for item_id.

    Search results are tagged with a 'path:' sentinel when they don't carry
    a real UUID (Dremio omits the id field for some result types).  Those must
    be looked up via the by-path endpoint; UUID-style ids use the normal route.
    """
    if item_id.startswith("path:"):
        segments = item_id[5:].split("/")
        encoded_path = "/".join(urllib.parse.quote(s, safe="") for s in segments)
        return f"{dremio_url}/api/v3/catalog/by-path/{encoded_path}"
    return f"{dremio_url}/api/v3/catalog/{urllib.parse.quote(item_id, safe='')}"


class CatalogItemHandler(APIHandler):
    @web.authenticated
    def get(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        resp = requests.get(
            _catalog_url(dremio_url, item_id),
            headers=_auth_header(token),
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())

    @web.authenticated
    def put(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        encoded = urllib.parse.quote(item_id, safe="")
        body = json.loads(self.request.body)
        resp = requests.put(
            f"{dremio_url}/api/v3/catalog/{encoded}",
            json=body,
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())

    @web.authenticated
    def delete(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        encoded = urllib.parse.quote(item_id, safe="")
        resp = requests.delete(
            f"{dremio_url}/api/v3/catalog/{encoded}",
            headers=_auth_header(token),
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.set_status(204)
        self.finish()


class SearchHandler(APIHandler):
    @web.authenticated
    def get(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        q = self.get_argument("q", "")
        max_results = int(self.get_argument("maxResults", "50"))
        resp = requests.post(
            f"{dremio_url}/api/v3/search",
            json={
                "query": q,
                "filter": 'category in ["TABLE", "VIEW"]',
                "pageToken": "",
                "maxResults": max_results,
            },
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        data = resp.json()
        # Log top-level keys so we can see the actual response shape in Jupyter logs
        self.log.info(
            "Dremio search q=%r status=%s top-level keys=%s",
            q,
            resp.status_code,
            list(data.keys()) if isinstance(data, dict) else repr(type(data)),
        )
        self.finish(data)


class FolderHandler(APIHandler):
    @web.authenticated
    def post(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        body = json.loads(self.request.body)
        path = body.get("path", [])
        resp = requests.post(
            f"{dremio_url}/api/v3/catalog",
            json={"entityType": "folder", "path": path},
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


def _resolve_uuid(dremio_url: str, token: str, item_id: str) -> str:
    """Resolve a path:-prefixed sentinel to a real Dremio UUID."""
    if item_id.startswith("path:"):
        segments = item_id[5:].split("/")
        encoded_path = "/".join(urllib.parse.quote(s, safe="") for s in segments)
        resp = requests.get(
            f"{dremio_url}/api/v3/catalog/by-path/{encoded_path}",
            headers=_auth_header(token),
            timeout=10,
        )
        if resp.ok:
            return resp.json().get("id", item_id)
    return item_id


class TagsHandler(APIHandler):
    @web.authenticated
    def get(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        resolved = _resolve_uuid(dremio_url, token, item_id)
        encoded = urllib.parse.quote(resolved, safe="")
        resp = requests.get(
            f"{dremio_url}/api/v3/catalog/{encoded}/collaboration/tag",
            headers=_auth_header(token),
            timeout=30,
        )
        if resp.status_code == 404:
            self.finish({"tags": []})
            return
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())

    @web.authenticated
    def post(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        resolved = _resolve_uuid(dremio_url, token, item_id)
        body = json.loads(self.request.body)
        encoded = urllib.parse.quote(resolved, safe="")
        resp = requests.post(
            f"{dremio_url}/api/v3/catalog/{encoded}/collaboration/tag",
            json=body,
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


class WikiHandler(APIHandler):
    @web.authenticated
    def get(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        encoded = urllib.parse.quote(item_id, safe="")
        url = f"{dremio_url}/api/v3/catalog/{encoded}/collaboration/wiki"
        resp = requests.get(url, headers=_auth_header(token), timeout=30)
        self.log.info("Dremio wiki %s → %s %s", url, resp.status_code, resp.text[:300])
        if resp.status_code == 404:
            self.finish({"text": None})
            return
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())

    @web.authenticated
    def post(self, item_id: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        encoded = urllib.parse.quote(item_id, safe="")
        body = json.loads(self.request.body)
        resp = requests.post(
            f"{dremio_url}/api/v3/catalog/{encoded}/collaboration/wiki",
            json=body,
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


class JobsHandler(APIHandler):
    @web.authenticated
    def get(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        headers = _auth_header(token)
        limit = self.get_argument("limit", "200")
        offset = self.get_argument("offset", "0")

        # Each tuple is (url, params). Tried in order; first successful response wins.
        # apiv2 receives no sort/order because it uses different field names and
        # may return 500 if it receives START_TIME (a v3-only enum value).
        candidates = [
            (
                f"{dremio_url}/api/v3/jobs",
                {"sort": "START_TIME", "order": "DESCENDING",
                 "limit": limit, "offset": offset},
            ),
            (
                f"{dremio_url}/apiv2/jobs",
                {"limit": limit, "offset": offset},
            ),
        ]

        resp = None
        for url, params in candidates:
            resp = requests.get(url, params=params, headers=headers, timeout=30)
            if resp.ok:
                break

        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)

        data = resp.json()
        # apiv2 wraps results in a "jobs" key; normalise to {"data": [...], "total": n}
        if "jobs" in data and "data" not in data:
            jobs = data["jobs"]
            data = {"data": jobs, "total": data.get("total", len(jobs))}

        self.finish(data)


def setup_handlers(web_app):
    base = web_app.settings["base_url"].rstrip("/")
    handlers = [
        (f"{base}/dremio/login", LoginHandler),
        (f"{base}/dremio/sso-login", SsoLoginHandler),
        (f"{base}/dremio/sso-logout", SsoLogoutHandler),
        (f"{base}/dremio/catalog/folder", FolderHandler),
        (f"{base}/dremio/catalog/search", SearchHandler),
        (f"{base}/dremio/tags/(.+)", TagsHandler),
        (f"{base}/dremio/wiki/(.+)", WikiHandler),
        (f"{base}/dremio/jobs", JobsHandler),
        (f"{base}/dremio/catalog", RootCatalogHandler),
        (f"{base}/dremio/catalog/(.+)", CatalogItemHandler),
    ]
    web_app.add_handlers(".*$", handlers)
