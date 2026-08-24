import importlib.util
import json
import os
import sys
import time
import types
import unittest
from unittest.mock import patch


class _Web:
    class HTTPError(Exception):
        def __init__(self, status_code, log_message=None):
            super().__init__(log_message)
            self.status_code = status_code

    @staticmethod
    def authenticated(method):
        return method


jupyter_handlers = types.ModuleType("jupyter_server.base.handlers")
jupyter_handlers.APIHandler = object
sys.modules.setdefault("jupyter_server", types.ModuleType("jupyter_server"))
sys.modules.setdefault("jupyter_server.base", types.ModuleType("jupyter_server.base"))
sys.modules["jupyter_server.base.handlers"] = jupyter_handlers
tornado = types.ModuleType("tornado")
tornado.web = _Web
sys.modules["tornado"] = tornado
sys.modules["tornado.web"] = _Web
requests_module = types.ModuleType("requests")
requests_module.Response = object
requests_module.RequestException = Exception
requests_module.get = lambda *args, **kwargs: None
requests_module.post = lambda *args, **kwargs: None
requests_module.put = lambda *args, **kwargs: None
requests_module.delete = lambda *args, **kwargs: None
sys.modules.setdefault("requests", requests_module)

spec = importlib.util.spec_from_file_location("dremio_handlers", "jupyter_dremio/handlers.py")
handlers = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = handlers
spec.loader.exec_module(handlers)


class Response:
    ok = True
    status_code = 200

    def __init__(self, data):
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


class OidcHandlerTests(unittest.TestCase):
    def test_pkce_challenge_matches_rfc7636_example(self):
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        self.assertEqual(
            handlers._b64url_sha256(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )

    def test_provider_config_supports_named_entra_and_okta(self):
        providers = {
            "entra": {"label": "Entra", "issuer": "https://login.example/tenant/v2.0", "client_id": "one"},
            "okta": {"label": "Okta", "issuer": "https://example.okta.com/oauth2/default", "client_id": "two"},
        }
        with patch.dict(os.environ, {"JUPYTER_DREMIO_OIDC_PROVIDERS": json.dumps(providers)}, clear=True):
            loaded = handlers._oidc_providers()
        self.assertEqual(set(loaded), {"entra", "okta"})
        self.assertEqual(loaded["entra"]["username_claim"], "preferred_username")

    def test_auth_headers_distinguish_oidc_and_kerberos(self):
        common = dict(dremio_url="https://dremio.example", owner="alice", username="alice")
        oidc = handlers.AuthSession(token="oauth", scheme="Bearer", **common)
        kerberos = handlers.AuthSession(token="session", scheme="_dremio", **common)
        self.assertEqual(handlers._auth_header(oidc), {"Authorization": "Bearer oauth"})
        self.assertEqual(handlers._auth_header(kerberos), {"Authorization": "_dremiosession"})

    def test_oidc_dremio_target_must_be_allowlisted(self):
        provider = {"dremio_urls": ["https://dremio.example"]}
        handlers._validate_oidc_dremio_url("https://dremio.example", provider)
        with self.assertRaises(_Web.HTTPError) as error:
            handlers._validate_oidc_dremio_url("https://attacker.example", provider)
        self.assertEqual(error.exception.status_code, 403)

    def test_external_jwt_is_exchanged_using_dremio_oauth(self):
        transaction = handlers.OidcTransaction(
            transaction_id="tx", state="state", nonce="nonce", code_verifier="verifier",
            redirect_uri="https://jupyter.example/dremio/oidc/callback",
            dremio_url="https://dremio.example", owner="alice", provider={}, discovery={}, created_at=0,
        )
        with patch.object(handlers.requests, "post", return_value=Response({"access_token": "dremio-oauth"})) as post:
            result = handlers.OidcCallbackHandler._exchange_dremio_token(transaction, "external.jwt.token")
        self.assertEqual(result["access_token"], "dremio-oauth")
        self.assertEqual(post.call_args.args[0], "https://dremio.example/oauth/token")
        self.assertEqual(post.call_args.kwargs["data"]["scope"], "dremio.all")

    @unittest.skipUnless(importlib.util.find_spec("jwt"), "PyJWT is not installed")
    def test_id_token_signature_audience_issuer_and_nonce_are_validated(self):
        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa

        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
        jwk["kid"] = "test-key"
        now = int(time.time())
        id_token = jwt.encode(
            {
                "iss": "https://identity.example",
                "aud": "client-id",
                "sub": "alice",
                "iat": now,
                "exp": now + 300,
                "nonce": "expected-nonce",
            },
            private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        transaction = handlers.OidcTransaction(
            transaction_id="tx", state="state", nonce="expected-nonce", code_verifier="verifier",
            redirect_uri="https://jupyter.example/dremio/oidc/callback",
            dremio_url="https://dremio.example", owner="alice",
            provider={"client_id": "client-id", "id_token_algorithms": ["RS256"]},
            discovery={"issuer": "https://identity.example", "jwks_uri": "https://identity.example/keys"},
            created_at=now,
        )
        callback = object.__new__(handlers.OidcCallbackHandler)
        with patch.object(handlers.requests, "get", return_value=Response({"keys": [jwk]})):
            claims = callback._validate_id_token(transaction, {"id_token": id_token})
        self.assertEqual(claims["sub"], "alice")


if __name__ == "__main__":
    unittest.main()
