import os

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from ..auth import make_token

router = APIRouter(prefix="/api", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
def login(body: LoginRequest):
    expected = os.environ.get("APP_PASSWORD", "")
    if not expected or body.password != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong password")
    return {"token": make_token()}
