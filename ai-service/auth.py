import base64
from contextlib import contextmanager
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

router = APIRouter()
SESSION_COOKIE = "scholarship_session"
SESSION_MAX_AGE = 7 * 24 * 60 * 60
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", Path(__file__).with_name("scholarship.db")))
COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "true").lower() in {"1", "true", "yes"}


@contextmanager
def connect_database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    try:
        os.chmod(DATABASE_PATH, 0o600)
    except OSError:
        pass
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database():
    with connect_database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
                created_at INTEGER NOT NULL,
                password_change_required INTEGER NOT NULL DEFAULT 0 CHECK (password_change_required IN (0, 1))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
            """
        )
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "password_change_required" not in columns:
            connection.execute(
                "ALTER TABLE users ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0"
            )


initialize_database()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$16384$8$1${}${}".format(
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(derived).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_value, hash_value = encoded.split("$")
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_value.encode("ascii"))
        expected = base64.urlsafe_b64decode(hash_value.encode("ascii"))
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def insert_account(email: str, password: str, role: str, password_change_required: bool = False):
    with connect_database() as connection:
        cursor = connection.execute(
            "INSERT INTO users (email, password_hash, role, created_at, password_change_required) VALUES (?, ?, ?, ?, ?)",
            (email.strip().lower(), hash_password(password), role, int(time.time()), int(password_change_required)),
        )
        return {"id": cursor.lastrowid, "email": email.strip().lower(), "role": role,
                "password_change_required": password_change_required}


def public_user(row):
    return {"id": row["id"], "email": row["email"], "role": row["role"],
            "password_change_required": bool(row["password_change_required"])}


def create_session(user_id: int, response: Response):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    expires_at = int(time.time()) + SESSION_MAX_AGE
    with connect_database() as connection:
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign-in required")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with connect_database() as connection:
        row = connection.execute(
            """SELECT users.id, users.email, users.role, users.password_change_required
               FROM sessions JOIN users ON users.id = sessions.user_id
               WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
            (token_hash, int(time.time())),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired or invalid")
    return public_user(row)


class StudentProvision(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    roll_number: str = Field(min_length=1, max_length=128)


class SignIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)


def normalized_email(email: str):
    normalized = email.strip().lower()
    if normalized.count("@") != 1 or "." not in normalized.rsplit("@", 1)[1]:
        raise HTTPException(status_code=422, detail="Enter a valid email address")
    return normalized


@router.post("/auth/register", status_code=status.HTTP_403_FORBIDDEN)
def register_student():
    raise HTTPException(status_code=403, detail="Student accounts are provisioned by the college. Contact your college administrator.")


def require_admin_user(user):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin account required")
    if user["password_change_required"]:
        raise HTTPException(status_code=428, detail="Change your password before accessing this service")
    return user


@router.post("/admin/students", status_code=status.HTTP_201_CREATED)
def provision_student(account: StudentProvision, user=Depends(current_user)):
    require_admin_user(user)
    email = normalized_email(account.email)
    roll_number = account.roll_number.strip()
    if not roll_number:
        raise HTTPException(status_code=422, detail="Roll number is required")
    try:
        student = insert_account(email, roll_number, "student", password_change_required=True)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    return {"student": student, "initial_password_is_roll_number": True}


@router.post("/auth/login")
def sign_in(credentials: SignIn, response: Response):
    email = normalized_email(credentials.email)
    with connect_database() as connection:
        row = connection.execute(
            "SELECT id, email, password_hash, role, password_change_required FROM users WHERE email = ? COLLATE NOCASE",
            (email,),
        ).fetchone()
    if row is None or not verify_password(credentials.password, row["password_hash"] if row else ""):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    create_session(row["id"], response)
    return public_user(row)


@router.post("/auth/change-password")
def change_password(payload: PasswordChange, request: Request, user=Depends(current_user)):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Sign-in required")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with connect_database() as connection:
        row = connection.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        if row is None or not verify_password(payload.current_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        if payload.new_password == payload.current_password:
            raise HTTPException(status_code=422, detail="Choose a password different from your roll number")
        connection.execute(
            "UPDATE users SET password_hash = ?, password_change_required = 0 WHERE id = ?",
            (hash_password(payload.new_password), user["id"]),
        )
        connection.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], token_hash)
        )
        updated = connection.execute(
            "SELECT id, email, role, password_change_required FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
    return public_user(updated)


@router.post("/auth/logout")
def sign_out(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with connect_database() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
    response.delete_cookie(
        key=SESSION_COOKIE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return {"status": "signed_out"}


@router.get("/auth/me")
def get_current_user(user=Depends(current_user)):
    return user


@router.get("/students/me")
def get_own_student_information(user=Depends(current_user)):
    ensure_password_changed(user)
    if user["role"] != "student":
        raise HTTPException(status_code=403, detail="Student account required")
    return {"student": user}


def ensure_password_changed(user):
    if user["password_change_required"]:
        raise HTTPException(status_code=428, detail="Change your initial password before accessing this service")
    return user


def create_admin_account(email: str, password: str):
    email = normalized_email(email)
    if len(password) < 12:
        raise ValueError("Admin password must contain at least 12 characters")
    return insert_account(email, password, "admin")
