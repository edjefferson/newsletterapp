import hashlib
import hmac
import os

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer = HTTPBearer(auto_error=False)


def _secret() -> str:
    s = os.environ.get("SECRET_KEY", "")
    if not s:
        raise RuntimeError("SECRET_KEY env var is not set")
    return s


def _expected_token() -> str:
    password = os.environ.get("APP_PASSWORD", "")
    return hmac.new(_secret().encode(), password.encode(), hashlib.sha256).hexdigest()  # type: ignore


def make_token() -> str:
    return _expected_token()


def require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)):
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    api_key = os.environ.get("API_KEY", "")
    if token == _expected_token() or (api_key and token == api_key):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing token",
        headers={"WWW-Authenticate": "Bearer"},
    )
