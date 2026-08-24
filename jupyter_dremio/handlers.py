import base64
import hashlib
import html
import json
import os
import secrets
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Optional, Union

import requests
from jupyter_server.base.handlers import APIHandler
from tornado import web

@dataclass
class AuthSession:
    token: str
    scheme: str
    dremio_url: str
    owner: str
    username: str
    expires_at: Optional[float] = None


@dataclass
class OidcTransaction:
    transaction_id: str
    state: str
    nonce: str
    code_verifier: str
    redirect_uri: str
    dremio_url: str
    owner: str
    provider: dict[str, Any]
    discovery: dict[str, Any]
    created_at: float
    session_id: Optional[str] = None
    username: Optional[str] = None
    error: Optional[str] = None


# Jupyter Server normally runs one process per user. Deployments using multiple
# web workers must replace these process-local stores with a shared TTL store.
_sso_sessions: dict[str, AuthSession] = {}
_oidc_transactions: dict[str, OidcTransaction] = {}
_oidc_states: dict[str, str] = {}

OIDC_TRANSACTION_TTL_SECONDS = 300


def _dremio_url(handler: APIHandler) -> str:
    url = handler.request.headers.get("X-Dremio-URL", "").rstrip("/")
    if not url:
        raise web.HTTPError(400, "Missing X-Dremio-URL header")
    return url


def _owner(handler: APIHandler) -> str:
    current_user = handler.current_user
    if isinstance(current_user, bytes):
        return current_user.decode("utf-8", errors="replace")
    if isinstance(current_user, dict):
        for key in ("name", "username", "user", "id"):
            if current_user.get(key):
                return str(current_user[key])
        return json.dumps(current_user, sort_keys=True, default=str)
    return str(current_user)


def _dremio_token(handler: APIHandler) -> AuthSession:
    raw = handler.request.headers.get("X-Dremio-Token", "")
    if raw.startswith("__sso__:"):
        session_id = raw[len("__sso__:"):]
        session = _sso_sessions.get(session_id)
        if not session:
            raise web.HTTPError(401, "SSO session expired or not found")
        if session.owner != _owner(handler) or session.dremio_url != _dremio_url(handler):
            raise web.HTTPError(403, "SSO session does not belong to this user or Dremio server")
        if session.expires_at is not None and session.expires_at <= time.time():
            _sso_sessions.pop(session_id, None)
            raise web.HTTPError(401, "SSO session expired; sign in again")
        return session
    return AuthSession(raw, "_dremio", _dremio_url(handler), _owner(handler), "")


def _auth_header(auth: Union[AuthSession, str]) -> dict[str, str]:
    if isinstance(auth, str):
        return {"Authorization": f"_dremio{auth}"}
    separator = " " if auth.scheme.lower() == "bearer" else ""
    return {"Authorization": f"{auth.scheme}{separator}{auth.token}"}


def _b64url_sha256(value: str) -> str:
    digest = hashlib.sha256(value.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _oidc_providers() -> dict[str, dict[str, Any]]:
    raw = os.environ.get("JUPYTER_DREMIO_OIDC_PROVIDERS", "").strip()
    if raw:
        try:
            providers = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise web.HTTPError(500, "JUPYTER_DREMIO_OIDC_PROVIDERS is not valid JSON") from exc
        if not isinstance(providers, dict):
            raise web.HTTPError(500, "JUPYTER_DREMIO_OIDC_PROVIDERS must be a JSON object")
    else:
        issuer = os.environ.get("JUPYTER_DREMIO_OIDC_ISSUER", "").strip()
        client_id = os.environ.get("JUPYTER_DREMIO_OIDC_CLIENT_ID", "").strip()
        if not issuer or not client_id:
            return {}
        providers = {
            "default": {
                "label": os.environ.get("JUPYTER_DREMIO_OIDC_LABEL", "Organisation SSO"),
                "issuer": issuer,
                "client_id": client_id,
                "client_secret": os.environ.get("JUPYTER_DREMIO_OIDC_CLIENT_SECRET", ""),
                "scopes": os.environ.get(
                    "JUPYTER_DREMIO_OIDC_SCOPES", "openid profile email"
                ),
                "username_claim": os.environ.get(
                    "JUPYTER_DREMIO_OIDC_USERNAME_CLAIM", "preferred_username"
                ),
            }
        }

    validated: dict[str, dict[str, Any]] = {}
    for provider_id, provider in providers.items():
        if not isinstance(provider_id, str) or not provider_id.replace("-", "").replace("_", "").isalnum():
            raise web.HTTPError(500, "OIDC provider IDs may contain only letters, numbers, '-' and '_'")
        if not isinstance(provider, dict) or not provider.get("issuer") or not provider.get("client_id"):
            raise web.HTTPError(500, f"OIDC provider '{provider_id}' requires issuer and client_id")
        configured = dict(provider)
        configured.setdefault("label", provider_id)
        configured.setdefault("scopes", "openid profile email")
        configured.setdefault("username_claim", "preferred_username")
        configured.setdefault("token_endpoint_auth_method", "client_secret_basic")
        validated[provider_id] = configured
    return validated


def _cleanup_oidc_transactions() -> None:
    cutoff = time.time() - OIDC_TRANSACTION_TTL_SECONDS
    expired = [key for key, transaction in _oidc_transactions.items() if transaction.created_at < cutoff]
    for transaction_id in expired:
        transaction = _oidc_transactions.pop(transaction_id)
        _oidc_states.pop(transaction.state, None)


def _oidc_callback_url(handler: APIHandler) -> str:
    configured = os.environ.get("JUPYTER_DREMIO_OIDC_REDIRECT_URI", "").strip()
    if configured:
        return configured
    callback_path = handler.request.path.rsplit("/", 1)[0] + "/callback"
    return f"{handler.request.protocol}://{handler.request.host}{callback_path}"


def _validate_oidc_dremio_url(dremio_url: str, provider: dict[str, Any]) -> None:
    allowed = provider.get("dremio_urls")
    if allowed is None:
        allowed = os.environ.get("JUPYTER_DREMIO_ALLOWED_URLS", "")
    if isinstance(allowed, str):
        allowed = [value.strip() for value in allowed.split(",") if value.strip()]
    if not isinstance(allowed, list) or not allowed:
        raise web.HTTPError(
            500,
            "OIDC requires an administrator-configured dremio_urls allowlist",
        )
    normalized = {str(value).rstrip("/") for value in allowed}
    if dremio_url not in normalized:
        raise web.HTTPError(403, "This Dremio URL is not allowed for the selected OIDC provider")


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


class CloudLoginHandler(APIHandler):
    """Exchange a Dremio Cloud PAT server-side to avoid browser CORS restrictions."""

    @web.authenticated
    def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError as exc:
            raise web.HTTPError(400, "Invalid JSON request body") from exc

        pat = body.get("pat", "").removeprefix("Bearer ").strip()
        if not pat:
            raise web.HTTPError(400, "Missing Dremio Cloud PAT")

        region = body.get("region", "us")
        login_url = {
            "us": "https://login.dremio.cloud/oauth/token",
            "eu": "https://login.eu.dremio.cloud/oauth/token",
        }.get(region)
        if not login_url:
            raise web.HTTPError(400, "Invalid Dremio Cloud control plane region")

        try:
            resp = requests.post(
                login_url,
                data={
                    "subject_token": pat,
                    "subject_token_type": "urn:ietf:params:oauth:token-type:dremio:personal-access-token",
                    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                    "scope": "dremio.all",
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            raise web.HTTPError(503, f"Cannot reach Dremio Cloud login: {exc}") from exc

        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)

        token = resp.json().get("access_token")
        if not token:
            raise web.HTTPError(502, "Dremio Cloud token exchange returned no access token")
        self.finish({"token": token})


class OidcProvidersHandler(APIHandler):
    @web.authenticated
    def get(self):
        providers = _oidc_providers()
        self.finish({
            "providers": [
                {"id": provider_id, "label": str(provider["label"])}
                for provider_id, provider in providers.items()
            ]
        })


class OidcStartHandler(APIHandler):
    @web.authenticated
    def post(self):
        _cleanup_oidc_transactions()
        dremio_url = _dremio_url(self)
        try:
            body = json.loads(self.request.body or b"{}")
        except json.JSONDecodeError as exc:
            raise web.HTTPError(400, "Invalid JSON request body") from exc

        provider_id = body.get("provider", "default")
        provider = _oidc_providers().get(provider_id)
        if provider is None:
            raise web.HTTPError(400, f"OIDC provider '{provider_id}' is not configured")
        _validate_oidc_dremio_url(dremio_url, provider)

        issuer = str(provider["issuer"]).rstrip("/")
        if not issuer.startswith("https://") and os.environ.get(
            "JUPYTER_DREMIO_OIDC_ALLOW_INSECURE_HTTP"
        ) != "1":
            raise web.HTTPError(500, "OIDC issuer must use HTTPS")

        try:
            discovery_response = requests.get(
                f"{issuer}/.well-known/openid-configuration", timeout=15
            )
        except requests.RequestException as exc:
            raise web.HTTPError(503, f"Cannot reach the OIDC provider: {exc}") from exc
        if not discovery_response.ok:
            raise web.HTTPError(
                502, f"OIDC discovery failed ({discovery_response.status_code})"
            )
        discovery = discovery_response.json()
        if str(discovery.get("issuer", "")).rstrip("/") != issuer:
            raise web.HTTPError(502, "OIDC discovery returned an unexpected issuer")
        for field in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            if not discovery.get(field):
                raise web.HTTPError(502, f"OIDC discovery response is missing {field}")

        transaction_id = secrets.token_urlsafe(24)
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        code_verifier = secrets.token_urlsafe(64)
        redirect_uri = _oidc_callback_url(self)
        transaction = OidcTransaction(
            transaction_id=transaction_id,
            state=state,
            nonce=nonce,
            code_verifier=code_verifier,
            redirect_uri=redirect_uri,
            dremio_url=dremio_url,
            owner=_owner(self),
            provider=provider,
            discovery=discovery,
            created_at=time.time(),
        )
        _oidc_transactions[transaction_id] = transaction
        _oidc_states[state] = transaction_id

        scopes = provider.get("scopes", "openid profile email")
        if isinstance(scopes, list):
            scopes = " ".join(str(scope) for scope in scopes)
        parameters: dict[str, Any] = {
            "response_type": "code",
            "client_id": provider["client_id"],
            "redirect_uri": redirect_uri,
            "scope": scopes,
            "state": state,
            "nonce": nonce,
            "code_challenge": _b64url_sha256(code_verifier),
            "code_challenge_method": "S256",
        }
        extra_parameters = provider.get("authorization_params", {})
        if isinstance(extra_parameters, dict):
            reserved = set(parameters)
            parameters.update({
                str(key): str(value)
                for key, value in extra_parameters.items()
                if str(key) not in reserved
            })
        authorization_url = (
            f"{discovery['authorization_endpoint']}?{urllib.parse.urlencode(parameters)}"
        )
        self.finish({"authorizationUrl": authorization_url, "transactionId": transaction_id})


class OidcCallbackHandler(APIHandler):
    @web.authenticated
    def get(self):
        _cleanup_oidc_transactions()
        state = self.get_query_argument("state", default="")
        transaction_id = _oidc_states.pop(state, None)
        transaction = _oidc_transactions.get(transaction_id or "")
        if transaction is None or not secrets.compare_digest(transaction.state, state):
            raise web.HTTPError(400, "Unknown or expired OIDC state")
        if transaction.owner != _owner(self):
            transaction.error = "OIDC callback belongs to a different Jupyter user"
            raise web.HTTPError(403, transaction.error)

        provider_error = self.get_query_argument("error", default="")
        if provider_error:
            description = self.get_query_argument("error_description", default=provider_error)
            transaction.error = f"Identity provider rejected sign-in: {description}"
            self._finish_page(transaction.error)
            return

        code = self.get_query_argument("code", default="")
        if not code:
            transaction.error = "Identity provider returned no authorization code"
            self._finish_page(transaction.error)
            return

        try:
            token_data = self._exchange_code(transaction, code)
            claims = self._validate_id_token(transaction, token_data)
            external_token = token_data.get("access_token", "")
            if external_token.count(".") != 2:
                raise ValueError(
                    "The provider returned an opaque access token; configure a JWT audience/scope for Dremio"
                )
            dremio_token = self._exchange_dremio_token(transaction, external_token)
            username_claim = str(transaction.provider.get("username_claim"))
            username = str(
                claims.get(username_claim)
                or claims.get("preferred_username")
                or claims.get("email")
                or claims.get("sub")
                or "oidc-user"
            )
            expires_in = int(dremio_token.get("expires_in", token_data.get("expires_in", 3600)))
            session_id = secrets.token_urlsafe(32)
            _sso_sessions[session_id] = AuthSession(
                token=dremio_token["access_token"],
                scheme="Bearer",
                dremio_url=transaction.dremio_url,
                owner=transaction.owner,
                username=username,
                expires_at=time.time() + max(1, expires_in - 15),
            )
            transaction.session_id = session_id
            transaction.username = username
            self._finish_page("Sign-in complete. This window can now close.")
        except Exception as exc:
            transaction.error = str(exc)
            self.log.warning("Dremio OIDC sign-in failed: %s", exc)
            self._finish_page(f"Sign-in failed: {exc}")

    def _exchange_code(self, transaction: OidcTransaction, code: str) -> dict[str, Any]:
        provider = transaction.provider
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": transaction.redirect_uri,
            "client_id": provider["client_id"],
            "code_verifier": transaction.code_verifier,
        }
        method = provider.get("token_endpoint_auth_method", "client_secret_basic")
        client_secret = str(provider.get("client_secret", ""))
        auth = None
        if client_secret and method == "client_secret_basic":
            auth = (provider["client_id"], client_secret)
        elif client_secret and method == "client_secret_post":
            data["client_secret"] = client_secret
        elif method not in ("none", "client_secret_basic", "client_secret_post"):
            raise ValueError(f"Unsupported token_endpoint_auth_method: {method}")
        response = requests.post(
            transaction.discovery["token_endpoint"], data=data, auth=auth, timeout=30
        )
        if not response.ok:
            raise ValueError(f"OIDC token request failed ({response.status_code}): {response.text[:300]}")
        token_data = response.json()
        if not token_data.get("id_token") or not token_data.get("access_token"):
            raise ValueError("OIDC token response did not contain both ID and access tokens")
        return token_data

    def _validate_id_token(
        self, transaction: OidcTransaction, token_data: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            import jwt
        except ImportError as exc:
            raise ValueError("PyJWT is not installed on the Jupyter server") from exc

        id_token = token_data["id_token"]
        header = jwt.get_unverified_header(id_token)
        algorithm = header.get("alg", "")
        allowed_algorithms = transaction.provider.get("id_token_algorithms", ["RS256"])
        if algorithm not in allowed_algorithms:
            raise ValueError(f"OIDC ID token uses unsupported signing algorithm {algorithm!r}")
        jwks_response = requests.get(transaction.discovery["jwks_uri"], timeout=15)
        if not jwks_response.ok:
            raise ValueError(f"OIDC signing keys request failed ({jwks_response.status_code})")
        keys = jwks_response.json().get("keys", [])
        key_data = next((key for key in keys if key.get("kid") == header.get("kid")), None)
        if key_data is None:
            raise ValueError("OIDC signing key was not found in the provider JWKS")
        signing_key = jwt.PyJWK.from_dict(key_data, algorithm=algorithm).key
        claims = jwt.decode(
            id_token,
            signing_key,
            algorithms=[algorithm],
            audience=transaction.provider["client_id"],
            issuer=transaction.discovery["issuer"],
            leeway=30,
            options={"require": ["exp", "iat", "iss", "aud", "nonce"]},
        )
        if not secrets.compare_digest(str(claims.get("nonce", "")), transaction.nonce):
            raise ValueError("OIDC ID token nonce did not match the login request")
        return claims

    @staticmethod
    def _exchange_dremio_token(
        transaction: OidcTransaction, external_token: str
    ) -> dict[str, Any]:
        response = requests.post(
            f"{transaction.dremio_url}/oauth/token",
            data={
                "subject_token": external_token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "scope": "dremio.all",
            },
            timeout=30,
        )
        if not response.ok:
            raise ValueError(f"Dremio token exchange failed ({response.status_code}): {response.text[:300]}")
        token_data = response.json()
        if not token_data.get("access_token"):
            raise ValueError("Dremio token exchange returned no access token")
        return token_data

    def _finish_page(self, message: str) -> None:
        self.set_header("Content-Type", "text/html; charset=UTF-8")
        self.finish(
            "<!doctype html><html><head><title>Dremio SSO</title></head>"
            f"<body><p>{html.escape(message)}</p></body></html>"
        )


class OidcStatusHandler(APIHandler):
    @web.authenticated
    def get(self, transaction_id: str):
        _cleanup_oidc_transactions()
        transaction = _oidc_transactions.get(transaction_id)
        if transaction is None or transaction.owner != _owner(self):
            raise web.HTTPError(404, "OIDC sign-in transaction not found")
        if transaction.error:
            _oidc_transactions.pop(transaction_id, None)
            self.finish({"status": "error", "error": transaction.error})
            return
        if not transaction.session_id:
            self.finish({"status": "pending"})
            return
        _oidc_transactions.pop(transaction_id, None)
        self.finish({
            "status": "complete",
            "token": f"__sso__:{transaction.session_id}",
            "userName": transaction.username,
            "authType": "oidc",
        })


class FlightTokenHandler(APIHandler):
    @web.authenticated
    def get(self):
        session = _dremio_token(self)
        if session.scheme.lower() != "bearer":
            raise web.HTTPError(400, "Flight Bearer credentials are available only for OIDC sessions")
        self.set_header("Cache-Control", "no-store")
        self.finish({"authorizationHeader": f"Bearer {session.token}"})


class SsoLoginHandler(APIHandler):
    """Authenticate with Kerberos/SPNEGO. Kept separate from generic OIDC SSO."""

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
        _sso_sessions[session_id] = AuthSession(
            token=token,
            scheme="_dremio",
            dremio_url=dremio_url,
            owner=_owner(self),
            username="sso-user",
        )

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

        _sso_sessions[session_id].username = user_name

        self.finish({
            "token": f"__sso__:{session_id}",
            "userName": user_name,
            "authType": "kerberos",
        })


class SsoLogoutHandler(APIHandler):
    @web.authenticated
    def post(self):
        raw = self.request.headers.get("X-Dremio-Token", "")
        if raw.startswith("__sso__:"):
            session_id = raw[len("__sso__:"):]
            session = _sso_sessions.get(session_id)
            if session and session.owner == _owner(self):
                _sso_sessions.pop(session_id, None)
        self.finish({})


class RootCatalogHandler(APIHandler):
    @web.authenticated
    def get(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        include = self.get_query_argument("include", default="")
        suffix = "?include=permissions" if include == "permissions" else ""
        resp = requests.get(
            f"{dremio_url}/api/v3/catalog{suffix}",
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
        include = self.get_query_argument("include", default="")
        suffix = "?include=permissions" if include == "permissions" else ""
        resp = requests.get(
            f"{_catalog_url(dremio_url, item_id)}{suffix}",
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


def _file_format_url(dremio_url: str, encoded_path: str, target: str) -> str:
    """Build a source file-format endpoint from a catalog path."""
    segments = [urllib.parse.unquote(segment) for segment in encoded_path.split("/")]
    if len(segments) < 2:
        raise web.HTTPError(400, "A source file path is required")
    source, *file_path = segments
    encoded_file_path = "/".join(urllib.parse.quote(segment, safe="") for segment in file_path)
    return (
        f"{dremio_url}/apiv2/source/{urllib.parse.quote(source, safe='')}"
        f"/{target}_format/{encoded_file_path}"
    )


class FileFormatHandler(APIHandler):
    def _finish_error(self, resp: requests.Response) -> None:
        """Preserve Dremio's file-format diagnostic instead of masking 500s."""
        self.set_status(resp.status_code)
        self.finish({"message": resp.text or "Dremio returned no error details"})

    @web.authenticated
    def get(self, target: str, path: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        resp = requests.get(
            _file_format_url(dremio_url, path, target),
            headers=_auth_header(token),
            timeout=30,
        )
        if not resp.ok:
            self._finish_error(resp)
            return
        self.finish(resp.json())

    @web.authenticated
    def put(self, target: str, path: str):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        body = json.loads(self.request.body)
        resp = requests.put(
            _file_format_url(dremio_url, path, target),
            json=body,
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            self._finish_error(resp)
            return
        self.finish(resp.json())


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


def _resolve_uuid(dremio_url: str, token: Union[AuthSession, str], item_id: str) -> str:
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


class SqlHandler(APIHandler):
    """Submit SQL as a Dremio job without using Arrow Flight result streaming."""

    @web.authenticated
    def post(self):
        dremio_url = _dremio_url(self)
        token = _dremio_token(self)
        body = json.loads(self.request.body)
        resp = requests.post(
            f"{dremio_url}/api/v3/sql",
            json=body,
            headers={**_auth_header(token), "Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            raise web.HTTPError(resp.status_code, resp.text)
        self.finish(resp.json())


def setup_handlers(web_app):
    base = web_app.settings["base_url"].rstrip("/")
    handlers = [
        (f"{base}/dremio/login", LoginHandler),
        (f"{base}/dremio/cloud/login", CloudLoginHandler),
        (f"{base}/dremio/oidc/providers", OidcProvidersHandler),
        (f"{base}/dremio/oidc/start", OidcStartHandler),
        (f"{base}/dremio/oidc/callback", OidcCallbackHandler),
        (f"{base}/dremio/oidc/status/([^/]+)", OidcStatusHandler),
        (f"{base}/dremio/auth/flight-token", FlightTokenHandler),
        (f"{base}/dremio/sso-login", SsoLoginHandler),
        (f"{base}/dremio/sso-logout", SsoLogoutHandler),
        (f"{base}/dremio/catalog/folder", FolderHandler),
        (f"{base}/dremio/catalog/search", SearchHandler),
        (f"{base}/dremio/(file|folder)-format/(.+)", FileFormatHandler),
        (f"{base}/dremio/tags/(.+)", TagsHandler),
        (f"{base}/dremio/wiki/(.+)", WikiHandler),
        (f"{base}/dremio/jobs", JobsHandler),
        (f"{base}/dremio/sql", SqlHandler),
        (f"{base}/dremio/catalog", RootCatalogHandler),
        (f"{base}/dremio/catalog/(.+)", CatalogItemHandler),
    ]
    web_app.add_handlers(".*$", handlers)
