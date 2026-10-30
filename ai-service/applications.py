import base64
import binascii
import json
import math
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from auth import connect_database, current_user, ensure_password_changed
from ai_review import AIReviewUnavailable, analyze_ocr_documents, _community_category_key
from document_ocr import extract_document_text

router = APIRouter()
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", Path(__file__).with_name("private-uploads")))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 10 * 1024 * 1024))
MAX_FILES_PER_APPLICATION = int(os.environ.get("MAX_FILES_PER_APPLICATION", 8))
DOCUMENT_TYPES = {"marksheet", "attendance_report", "bonafide_certificate", "income_certificate", "community_certificate", "other"}
DOCUMENT_SIGNATURES = {
    "application/pdf": (b"%PDF-", ".pdf"),
    "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
    "image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
}
APPLICATION_STATUSES = {
    "Draft", "Submitted", "Under Review", "Documents Required",
    "Resubmitted", "Verified", "Rejected",
}
ADMIN_TRANSITIONS = {
    "Submitted": {"Under Review", "Documents Required", "Verified", "Rejected"},
    "Under Review": {"Documents Required", "Verified", "Rejected"},
    "Resubmitted": {"Under Review", "Documents Required", "Verified", "Rejected"},
    "Documents Required": {"Under Review", "Rejected"},
}


def initialize_application_tables():
    with connect_database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS renewal_applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                application_number TEXT NOT NULL UNIQUE,
                student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                scholarship_scheme TEXT NOT NULL COLLATE NOCASE,
                renewal_year INTEGER NOT NULL,
                application_type TEXT NOT NULL DEFAULT 'renewal' CHECK (application_type IN ('first_time', 'renewal')),
                status TEXT NOT NULL CHECK (status IN ('Draft', 'Submitted', 'Under Review', 'Documents Required', 'Resubmitted', 'Verified', 'Rejected')),
                student_information TEXT NOT NULL DEFAULT '{}',
                previous_scholarship TEXT NOT NULL DEFAULT '{}',
                academic_details TEXT NOT NULL DEFAULT '{}',
                financial_details TEXT NOT NULL DEFAULT '{}',
                declaration TEXT NOT NULL DEFAULT '{}',
                admin_feedback TEXT,
                missing_documents TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                submitted_at INTEGER,
                UNIQUE (student_id, scholarship_scheme, renewal_year)
            );
            CREATE INDEX IF NOT EXISTS renewal_applications_student_idx ON renewal_applications(student_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS renewal_applications_status_idx ON renewal_applications(status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS application_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                application_id INTEGER NOT NULL REFERENCES renewal_applications(id) ON DELETE CASCADE,
                uploaded_by INTEGER NOT NULL REFERENCES users(id),
                document_type TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                storage_name TEXT NOT NULL UNIQUE,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                ocr_status TEXT NOT NULL DEFAULT 'pending',
                ocr_text TEXT NOT NULL DEFAULT '',
                ocr_method TEXT,
                ocr_confidence REAL,
                ocr_error TEXT
            );
            CREATE INDEX IF NOT EXISTS application_documents_app_idx ON application_documents(application_id, created_at);
            CREATE TABLE IF NOT EXISTS scholarships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                description TEXT NOT NULL DEFAULT '',
                required_document_types TEXT NOT NULL DEFAULT '[]',
                eligibility_rules TEXT NOT NULL DEFAULT '{}',
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS student_academic_profiles (
                student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                cgpa REAL NOT NULL,
                cgpa_scale REAL NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS student_profiles (
                student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                profile_json TEXT NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS scholarships_active_idx ON scholarships(is_active, name);
            CREATE TABLE IF NOT EXISTS application_ai_reviews (
                application_id INTEGER PRIMARY KEY REFERENCES renewal_applications(id) ON DELETE CASCADE,
                report_json TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )
        application_columns = {row["name"] for row in connection.execute("PRAGMA table_info(renewal_applications)")}
        if "application_type" not in application_columns:
            connection.execute(
                "ALTER TABLE renewal_applications ADD COLUMN application_type TEXT NOT NULL DEFAULT 'renewal' CHECK (application_type IN ('first_time', 'renewal'))"
            )
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(application_documents)")}
        migrations = {
            "ocr_status": "TEXT NOT NULL DEFAULT 'pending'",
            "ocr_text": "TEXT NOT NULL DEFAULT ''",
            "ocr_method": "TEXT",
            "ocr_confidence": "REAL",
            "ocr_error": "TEXT",
        }
        for name, definition in migrations.items():
            if name not in columns:
                connection.execute(f"ALTER TABLE application_documents ADD COLUMN {name} {definition}")
        scholarship_columns = {row["name"] for row in connection.execute("PRAGMA table_info(scholarships)")}
        if "eligibility_rules" not in scholarship_columns:
            connection.execute("ALTER TABLE scholarships ADD COLUMN eligibility_rules TEXT NOT NULL DEFAULT '{}'")
        legacy_profiles = connection.execute(
            "SELECT student_id, student_information, updated_at FROM renewal_applications ORDER BY updated_at DESC"
        ).fetchall()
        for profile in legacy_profiles:
            information = json.loads(profile["student_information"])
            reusable_fields = (
                "full_name", "college_registration_number", "mobile_number", "college_name",
                "department_or_course", "current_year_of_study",
            )
            if not any(information.get(key) for key in reusable_fields):
                continue
            connection.execute(
                "INSERT OR IGNORE INTO student_profiles (student_id, profile_json, updated_at) VALUES (?, ?, ?)",
                (profile["student_id"], profile["student_information"], profile["updated_at"]),
            )


initialize_application_tables()


class ApplicationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scholarship_scheme: str = Field(min_length=1, max_length=160)
    renewal_year: int = Field(ge=2000, le=2200)
    application_type: Literal["first_time", "renewal"] = "renewal"
    student_information: dict = Field(default_factory=dict)
    previous_scholarship: dict = Field(default_factory=dict)
    academic_details: dict = Field(default_factory=dict)
    financial_details: dict = Field(default_factory=dict)
    declaration: dict = Field(default_factory=dict)


class DocumentPayload(BaseModel):
    document_type: Literal["marksheet", "attendance_report", "bonafide_certificate", "income_certificate", "community_certificate", "other"]
    original_filename: str = Field(min_length=1, max_length=255)
    content_type: Literal["application/pdf", "image/jpeg", "image/png"]
    content_base64: str = Field(min_length=1, max_length=((MAX_UPLOAD_BYTES + 2) // 3) * 4)


class ReviewPayload(BaseModel):
    status: Literal["Draft", "Submitted", "Under Review", "Documents Required", "Resubmitted", "Verified", "Rejected"]
    feedback: str = Field(default="", max_length=4000)
    missing_document_types: list[Literal["marksheet", "attendance_report", "bonafide_certificate", "income_certificate", "community_certificate", "other"]] = Field(default_factory=list)


class ScholarshipEligibilityRules(BaseModel):
    model_config = ConfigDict(extra="forbid")

    minimum_percentage: Optional[float] = Field(default=None, ge=0, le=100)
    minimum_cgpa: Optional[float] = Field(default=None, ge=0, le=100)
    cgpa_scale: Optional[float] = Field(default=None, gt=0, le=100)
    minimum_attendance_percent: Optional[float] = Field(default=None, ge=0, le=100)
    maximum_arrears: Optional[float] = Field(default=None, ge=0)
    maximum_annual_family_income: Optional[float] = Field(default=None, ge=0)
    required_community_category: Optional[str] = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def validate_cgpa_rule(self):
        if self.required_community_category is not None:
            self.required_community_category = self.required_community_category.strip() or None
        if (self.minimum_cgpa is None) != (self.cgpa_scale is None):
            raise ValueError("Set both minimum_cgpa and cgpa_scale")
        if self.minimum_cgpa is not None and self.minimum_cgpa > self.cgpa_scale:
            raise ValueError("minimum_cgpa cannot be greater than cgpa_scale")
        return self


class StudentAcademicProfilePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cgpa: float = Field(ge=0, le=100)
    cgpa_scale: float = Field(gt=0, le=100)

    @model_validator(mode="after")
    def validate_cgpa_value(self):
        if self.cgpa > self.cgpa_scale:
            raise ValueError("cgpa cannot be greater than cgpa_scale")
        return self


class ScholarshipPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    required_document_types: list[Literal["marksheet", "attendance_report", "bonafide_certificate", "income_certificate", "community_certificate", "other"]] = Field(default_factory=list, max_length=6)
    eligibility_rules: ScholarshipEligibilityRules = Field(default_factory=ScholarshipEligibilityRules)

    @model_validator(mode="after")
    def require_community_certificate(self):
        if self.eligibility_rules.required_community_category and "community_certificate" not in self.required_document_types:
            raise ValueError("A community certificate must be required when a community category is specified")
        return self


class ScholarshipActivePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool


class ScholarshipRequirementsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    required_document_types: list[Literal["marksheet", "attendance_report", "bonafide_certificate", "income_certificate", "community_certificate", "other"]] = Field(default_factory=list, max_length=6)
    eligibility_rules: ScholarshipEligibilityRules = Field(default_factory=ScholarshipEligibilityRules)

    @model_validator(mode="after")
    def require_community_certificate(self):
        if self.eligibility_rules.required_community_category and "community_certificate" not in self.required_document_types:
            raise ValueError("A community certificate must be required when a community category is specified")
        return self


def parse_scholarship(row):
    scholarship = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "required_document_types": json.loads(row["required_document_types"]),
        "eligibility_rules": json.loads(row["eligibility_rules"]),
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if "registered_student_count" in row.keys():
        scholarship["registered_student_count"] = row["registered_student_count"]
    return scholarship


def get_student_academic_profile(student_id):
    with connect_database() as connection:
        row = connection.execute(
            "SELECT cgpa, cgpa_scale, updated_at FROM student_academic_profiles WHERE student_id = ?",
            (student_id,),
        ).fetchone()
    return dict(row) if row else None


STUDENT_PROFILE_FIELDS = (
    "full_name", "college_registration_number", "mobile_number", "college_name",
    "department_or_course", "current_year_of_study",
)


def get_student_profile(student_id):
    with connect_database() as connection:
        row = connection.execute(
            "SELECT profile_json FROM student_profiles WHERE student_id = ?", (student_id,)
        ).fetchone()
    return json.loads(row["profile_json"]) if row else {}


def save_student_profile(connection, student_id, student_information, updated_at):
    profile = {
        key: str(student_information.get(key) or "").strip()
        for key in STUDENT_PROFILE_FIELDS
    }
    connection.execute(
        "INSERT INTO student_profiles (student_id, profile_json, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(student_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at",
        (student_id, json.dumps(profile), updated_at),
    )


def meets_scholarship_cgpa(scholarship, academic_profile):
    rules = scholarship.get("eligibility_rules", {})
    minimum = rules.get("minimum_cgpa") if isinstance(rules, dict) else None
    if minimum is None:
        return True
    if academic_profile is None:
        return False
    required_scale = rules.get("cgpa_scale")
    return (
        required_scale is not None
        and math.isclose(float(academic_profile["cgpa_scale"]), float(required_scale), abs_tol=0.001)
        and float(academic_profile["cgpa"]) >= float(minimum)
    )


def require_student(user=Depends(current_user)):
    ensure_password_changed(user)
    if user["role"] != "student":
        raise HTTPException(status_code=403, detail="Student account required")
    return user


def require_admin(user=Depends(current_user)):
    ensure_password_changed(user)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin account required")
    return user


@router.get("/scholarships")
def list_scholarships(user=Depends(current_user)):
    ensure_password_changed(user)
    with connect_database() as connection:
        rows = connection.execute(
            "SELECT * FROM scholarships WHERE is_active = 1 ORDER BY name COLLATE NOCASE"
            if user["role"] == "student"
            else """SELECT scholarships.*,
                      (SELECT COUNT(DISTINCT student_id) FROM renewal_applications
                       WHERE renewal_applications.scholarship_scheme = scholarships.name COLLATE NOCASE)
                      AS registered_student_count
                      FROM scholarships ORDER BY is_active DESC, name COLLATE NOCASE"""
        ).fetchall()
    scholarships = [parse_scholarship(row) for row in rows]
    if user["role"] == "student":
        academic_profile = get_student_academic_profile(user["id"])
        scholarships = [
            scholarship for scholarship in scholarships
            if meets_scholarship_cgpa(scholarship, academic_profile)
        ]
    return {"scholarships": scholarships}


@router.get("/students/me/academic-profile")
def get_own_student_academic_profile(user=Depends(require_student)):
    academic_profile = get_student_academic_profile(user["id"])
    return {"academic_profile": academic_profile}


@router.get("/admin/students/academic-profiles")
def list_student_academic_profiles(user=Depends(require_admin)):
    with connect_database() as connection:
        rows = connection.execute(
            """SELECT users.id, users.email, profiles.cgpa, profiles.cgpa_scale, profiles.updated_at
               FROM users LEFT JOIN student_academic_profiles AS profiles ON profiles.student_id = users.id
               WHERE users.role = 'student' ORDER BY users.email COLLATE NOCASE"""
        ).fetchall()
    return {"students": [dict(row) for row in rows]}


@router.put("/admin/students/{student_id}/academic-profile")
def set_student_academic_profile(student_id: int, payload: StudentAcademicProfilePayload, user=Depends(require_admin)):
    now = int(time.time())
    with connect_database() as connection:
        student = connection.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
        ).fetchone()
        if student is None:
            raise HTTPException(status_code=404, detail="Student account not found")
        connection.execute(
            "INSERT INTO student_academic_profiles (student_id, cgpa, cgpa_scale, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(student_id) DO UPDATE SET cgpa = excluded.cgpa, cgpa_scale = excluded.cgpa_scale, updated_at = excluded.updated_at",
            (student_id, payload.cgpa, payload.cgpa_scale, now),
        )
    return {"academic_profile": {"student_id": student_id, "cgpa": payload.cgpa, "cgpa_scale": payload.cgpa_scale, "updated_at": now}}


@router.post("/admin/scholarships", status_code=status.HTTP_201_CREATED)
def create_scholarship(payload: ScholarshipPayload, user=Depends(require_admin)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Scholarship name is required")
    now = int(time.time())
    required_documents = list(dict.fromkeys(payload.required_document_types))
    try:
        with connect_database() as connection:
            cursor = connection.execute(
                """INSERT INTO scholarships
                (name, description, required_document_types, eligibility_rules, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (name, payload.description.strip(), json.dumps(required_documents), json.dumps(payload.eligibility_rules.model_dump(exclude_none=True)), user["id"], now, now),
            )
            row = connection.execute("SELECT * FROM scholarships WHERE id = ?", (cursor.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="A scholarship with this name already exists")
    return parse_scholarship(row)


@router.get("/admin/scholarships/{scholarship_id}/applications")
def list_scholarship_applications(scholarship_id: int, user=Depends(require_admin)):
    with connect_database() as connection:
        scholarship = connection.execute(
            "SELECT id, name FROM scholarships WHERE id = ?", (scholarship_id,)
        ).fetchone()
        if scholarship is None:
            raise HTTPException(status_code=404, detail="Scholarship not found")
        rows = connection.execute(
            """SELECT renewal_applications.*, users.email AS student_email
               FROM renewal_applications
               JOIN users ON users.id = renewal_applications.student_id
               WHERE renewal_applications.scholarship_scheme = ? COLLATE NOCASE
               ORDER BY renewal_applications.updated_at DESC""",
            (scholarship["name"],),
        ).fetchall()
    applications = []
    for row in rows:
        application = parse_application(row)
        application["student_email"] = row["student_email"]
        application["student_name"] = application["student_information"].get("full_name") or row["student_email"]
        applications.append(application)
    return {"scholarship": dict(scholarship), "registered_students": applications, "total": len(applications)}


@router.patch("/admin/scholarships/{scholarship_id}/status")
def set_scholarship_status(scholarship_id: int, payload: ScholarshipActivePayload, user=Depends(require_admin)):
    with connect_database() as connection:
        cursor = connection.execute(
            "UPDATE scholarships SET is_active = ?, updated_at = ? WHERE id = ?",
            (int(payload.is_active), int(time.time()), scholarship_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Scholarship not found")
        row = connection.execute("SELECT * FROM scholarships WHERE id = ?", (scholarship_id,)).fetchone()
    return parse_scholarship(row)


@router.patch("/admin/scholarships/{scholarship_id}/requirements")
def update_scholarship_requirements(scholarship_id: int, payload: ScholarshipRequirementsPayload, user=Depends(require_admin)):
    with connect_database() as connection:
        cursor = connection.execute(
            "UPDATE scholarships SET required_document_types = ?, eligibility_rules = ?, updated_at = ? WHERE id = ?",
            (json.dumps(list(dict.fromkeys(payload.required_document_types))),
             json.dumps(payload.eligibility_rules.model_dump(exclude_none=True)), int(time.time()), scholarship_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Scholarship not found")
        row = connection.execute("SELECT * FROM scholarships WHERE id = ?", (scholarship_id,)).fetchone()
        connection.execute(
            "DELETE FROM application_ai_reviews WHERE application_id IN (SELECT id FROM renewal_applications WHERE scholarship_scheme = ? COLLATE NOCASE)",
            (row["name"],),
        )
    return parse_scholarship(row)


def parse_application(row):
    return {
        "id": row["id"],
        "application_number": row["application_number"],
        "scholarship_scheme": row["scholarship_scheme"],
        "renewal_year": row["renewal_year"],
        "application_type": row["application_type"],
        "status": row["status"],
        "student_information": json.loads(row["student_information"]),
        "previous_scholarship": json.loads(row["previous_scholarship"]),
        "academic_details": json.loads(row["academic_details"]),
        "financial_details": json.loads(row["financial_details"]),
        "declaration": json.loads(row["declaration"]),
        "admin_feedback": row["admin_feedback"],
        "missing_document_types": json.loads(row["missing_documents"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "submitted_at": row["submitted_at"],
    }


def fetch_owned_application(application_id: int, user):
    with connect_database() as connection:
        row = connection.execute(
            "SELECT * FROM renewal_applications WHERE id = ? AND student_id = ?",
            (application_id, user["id"]),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Application not found")
    return row


def fetch_application_for_admin(application_id: int):
    with connect_database() as connection:
        row = connection.execute(
            "SELECT * FROM renewal_applications WHERE id = ?", (application_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Application not found")
    return row


def scheme_rules(scheme: str):
    with connect_database() as connection:
        scholarship = connection.execute(
            "SELECT required_document_types, eligibility_rules FROM scholarships WHERE name = ? COLLATE NOCASE",
            (scheme,),
        ).fetchone()
    if scholarship:
        return {
            "required_document_types": json.loads(scholarship["required_document_types"]),
            "eligibility_rules": json.loads(scholarship["eligibility_rules"]),
        }
    try:
        rules = json.loads(os.environ.get("SCHEME_RULES_JSON", "{}"))
    except json.JSONDecodeError:
        return None
    if not isinstance(rules, dict):
        return None
    configured = rules.get(scheme)
    if not isinstance(configured, dict):
        return None
    eligibility = configured.get("eligibility_rules", {})
    if not isinstance(eligibility, dict):
        eligibility = {}
    valid_eligibility = {}
    for key in ("minimum_percentage", "minimum_cgpa", "cgpa_scale", "minimum_attendance_percent", "maximum_arrears", "maximum_annual_family_income"):
        value = eligibility.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            valid_eligibility[key] = value
    community_category = eligibility.get("required_community_category")
    if isinstance(community_category, str) and community_category.strip():
        valid_eligibility["required_community_category"] = community_category.strip()[:80]
    required_document_types = configured.get("required_document_types", [])
    if not isinstance(required_document_types, list):
        required_document_types = []
    if valid_eligibility.get("required_community_category") and "community_certificate" not in required_document_types:
        required_document_types.append("community_certificate")
    return {
        "required_document_types": required_document_types,
        "eligibility_rules": valid_eligibility,
    }


def configured_eligibility(application, rules):
    results = []
    academic = application["academic_details"]
    financial = application["financial_details"]
    checks = (rules or {}).get("eligibility_rules", {})
    if not isinstance(checks, dict):
        checks = {}
    def numeric_value(value):
        try:
            if value is None or isinstance(value, bool):
                return None
            number = float(value)
            return number if math.isfinite(number) else None
        except (TypeError, ValueError):
            return None

    if "minimum_percentage" in checks:
        provided = academic.get("percentage")
        minimum = checks["minimum_percentage"]
        number = numeric_value(provided)
        results.append({
            "rule": "minimum_percentage",
            "configured_value": minimum,
            "provided_value": provided,
            "passed": number is not None and number >= minimum,
        })
    if "minimum_cgpa" in checks:
        provided = academic.get("previous_marks_or_cgpa")
        provided_scale = numeric_value(academic.get("maximum_marks_or_grading_scale"))
        minimum = checks["minimum_cgpa"]
        required_scale = numeric_value(checks.get("cgpa_scale"))
        number = numeric_value(provided)
        matching_scale = required_scale is not None and provided_scale is not None and math.isclose(provided_scale, required_scale, abs_tol=0.001)
        results.append({
            "rule": "minimum_cgpa",
            "configured_value": minimum,
            "cgpa_scale": required_scale,
            "provided_value": provided,
            "provided_scale": provided_scale,
            "passed": matching_scale and number is not None and number >= minimum,
        })
    if "minimum_attendance_percent" in checks:
        provided = academic.get("attendance_percent")
        minimum = checks["minimum_attendance_percent"]
        number = numeric_value(provided)
        results.append({
            "rule": "minimum_attendance_percent",
            "configured_value": minimum,
            "provided_value": provided,
            "passed": number is not None and number >= minimum,
        })
    if "maximum_arrears" in checks:
        provided = academic.get("arrears")
        maximum = checks["maximum_arrears"]
        number = numeric_value(provided)
        results.append({
            "rule": "maximum_arrears",
            "configured_value": maximum,
            "provided_value": provided,
            "passed": number is not None and number <= maximum,
        })
    if "maximum_annual_family_income" in checks:
        provided = financial.get("annual_family_income")
        maximum = checks["maximum_annual_family_income"]
        number = numeric_value(provided)
        results.append({
            "rule": "maximum_annual_family_income",
            "configured_value": maximum,
            "provided_value": provided,
            "passed": number is not None and number <= maximum,
        })
    return results


def application_assessment(application, rules):
    required_types = (rules or {}).get("required_document_types", [])
    if not isinstance(required_types, list) or any(not isinstance(item, str) or item not in DOCUMENT_TYPES for item in required_types):
        required_types = []
    requested = application["missing_document_types"]
    if not isinstance(requested, list) or any(not isinstance(item, str) or item not in DOCUMENT_TYPES for item in requested):
        requested = []
    required_types = list(dict.fromkeys([*required_types, *requested]))
    with connect_database() as connection:
        rows = connection.execute(
            "SELECT document_type FROM application_documents WHERE application_id = ?",
            (application["id"],),
        ).fetchall()
    uploaded = {row["document_type"] for row in rows}
    missing = [document_type for document_type in required_types if document_type not in uploaded]
    eligibility = configured_eligibility(application, rules)
    review_pending = application["status"] in {"Submitted", "Under Review", "Documents Required", "Resubmitted"}
    return {
        "form_validation_errors": validation_errors(application, require_declaration=False),
        "missing_document_warnings": missing,
        "eligibility_checks": {
            "configured": bool(eligibility),
            "checks": eligibility,
            "unconfigured": not bool(eligibility),
        },
        "administrative_verification_items": (
            ["Submitted academic and financial details require administrative verification."]
            if review_pending else []
        ),
    }


def validation_errors(application, require_declaration=True):
    required_values = {
        "student_information.full_name": application["student_information"].get("full_name"),
        "student_information.college_registration_number": application["student_information"].get("college_registration_number"),
        "student_information.email": application["student_information"].get("email"),
        "student_information.mobile_number": application["student_information"].get("mobile_number"),
        "student_information.college_name": application["student_information"].get("college_name"),
        "student_information.department_or_course": application["student_information"].get("department_or_course"),
        "student_information.current_year_of_study": application["student_information"].get("current_year_of_study"),
        "academic_details.previous_marks_or_cgpa": application["academic_details"].get("previous_marks_or_cgpa"),
        "academic_details.maximum_marks_or_grading_scale": application["academic_details"].get("maximum_marks_or_grading_scale"),
        "academic_details.current_semester_or_academic_year": application["academic_details"].get("current_semester_or_academic_year"),
        "financial_details.annual_family_income": application["financial_details"].get("annual_family_income"),
    }
    if application.get("application_type", "renewal") == "renewal":
        required_values.update({
            "previous_scholarship.previous_application_reference": application["previous_scholarship"].get("previous_application_reference"),
            "previous_scholarship.previous_scholarship_academic_year": application["previous_scholarship"].get("previous_scholarship_academic_year"),
        })
    errors = [f"{field} is required" for field, value in required_values.items() if value is None or (isinstance(value, str) and not value.strip())]
    maximum_lengths = {
        "student_information.full_name": (application["student_information"].get("full_name"), 120),
        "student_information.college_registration_number": (application["student_information"].get("college_registration_number"), 80),
        "student_information.email": (application["student_information"].get("email"), 254),
        "student_information.mobile_number": (application["student_information"].get("mobile_number"), 32),
        "student_information.college_name": (application["student_information"].get("college_name"), 200),
        "student_information.department_or_course": (application["student_information"].get("department_or_course"), 160),
        "student_information.current_year_of_study": (application["student_information"].get("current_year_of_study"), 60),
        "academic_details.current_semester_or_academic_year": (application["academic_details"].get("current_semester_or_academic_year"), 80),
    }
    if application.get("application_type", "renewal") == "renewal":
        maximum_lengths.update({
            "previous_scholarship.previous_application_reference": (application["previous_scholarship"].get("previous_application_reference"), 120),
            "previous_scholarship.previous_scholarship_academic_year": (application["previous_scholarship"].get("previous_scholarship_academic_year"), 40),
        })
    for field, (value, maximum) in maximum_lengths.items():
        if value is not None and not isinstance(value, str):
            errors.append(f"{field} must be text")
        elif isinstance(value, str) and len(value.strip()) > maximum:
            errors.append(f"{field} must be at most {maximum} characters")
    email = application["student_information"].get("email", "")
    if email and (not isinstance(email, str) or email.count("@") != 1 or "." not in email.rsplit("@", 1)[1]):
        errors.append("student_information.email must be a valid email address")
    mobile = application["student_information"].get("mobile_number", "")
    if mobile and (not isinstance(mobile, str) or not re.fullmatch(r"[+\d][\d\s()-]{5,19}", mobile)):
        errors.append("student_information.mobile_number has an invalid format")
    for key in ("previous_marks_or_cgpa", "maximum_marks_or_grading_scale"):
        value = application["academic_details"].get(key)
        if value is not None:
            try:
                number = float(value)
                if isinstance(value, bool) or not math.isfinite(number) or number < 0:
                    errors.append(f"academic_details.{key} must be zero or greater")
            except (TypeError, ValueError):
                errors.append(f"academic_details.{key} must be numeric")
    previous_score = application["academic_details"].get("previous_marks_or_cgpa")
    grading_scale = application["academic_details"].get("maximum_marks_or_grading_scale")
    try:
        if grading_scale is not None and math.isfinite(float(grading_scale)) and float(grading_scale) <= 0:
            errors.append("academic_details.maximum_marks_or_grading_scale must be greater than zero")
        if previous_score is not None and grading_scale is not None and math.isfinite(float(previous_score)) and math.isfinite(float(grading_scale)) and float(previous_score) > float(grading_scale):
            errors.append("academic_details.previous_marks_or_cgpa cannot exceed its maximum marks or grading scale")
    except (TypeError, ValueError):
        pass
    arrears = application["academic_details"].get("arrears")
    if arrears is not None and (isinstance(arrears, bool) or not isinstance(arrears, int) or arrears < 0):
        errors.append("academic_details.arrears must be a non-negative whole number")
    percentage = application["academic_details"].get("percentage")
    if percentage not in (None, ""):
        try:
            number = float(percentage)
            if isinstance(percentage, bool) or not math.isfinite(number) or not 0 <= number <= 100:
                errors.append("academic_details.percentage must be between 0 and 100")
        except (TypeError, ValueError):
            errors.append("academic_details.percentage must be numeric")
    income = application["financial_details"].get("annual_family_income")
    if income is not None:
        try:
            number = float(income)
            if isinstance(income, bool) or not math.isfinite(number) or number < 0:
                errors.append("financial_details.annual_family_income must be zero or greater")
        except (TypeError, ValueError):
            errors.append("financial_details.annual_family_income must be numeric")
    if require_declaration and application["declaration"].get("confirmed") is not True:
        errors.append("declaration.confirmed must be accepted before submission")
    current_year = application["student_information"].get("current_year_of_study")
    if current_year not in (None, ""):
        try:
            if int(current_year) < 1:
                errors.append("student_information.current_year_of_study must be a positive year number")
        except (TypeError, ValueError):
            errors.append("student_information.current_year_of_study must be a year number")
    return errors


def get_document_path(storage_name):
    if not re.fullmatch(r"[a-f0-9]{32}\.(pdf|jpg|png)", storage_name):
        raise HTTPException(status_code=404, detail="Document not found")
    return UPLOAD_DIR / storage_name


def _admin_requirement_suggestion(checks, missing_documents, documents, unreadable_documents):
    failed_checks = [item["rule"] for item in checks if item["status"] == "failed"]
    undetermined_checks = [item["rule"] for item in checks if item["status"] == "undetermined"]
    reasons = []

    if failed_checks:
        reasons.append("OCR findings do not appear to meet these configured requirements: " + ", ".join(failed_checks) + ".")
    if missing_documents:
        reasons.append("Required document types not detected: " + ", ".join(missing_documents) + ".")
    if failed_checks or missing_documents:
        return {
            "status": "requirements_not_met",
            "title": "OCR suggests one or more requirements may not be met",
            "reasons": reasons,
        }

    if undetermined_checks:
        reasons.append("Could not determine these configured checks from readable OCR values: " + ", ".join(undetermined_checks) + ".")
    if not checks:
        reasons.append("No scholarship eligibility checks are configured, so requirements cannot be assessed.")
    if unreadable_documents:
        reasons.append(f"{len(unreadable_documents)} document(s) have no readable OCR result.")

    uncertain_documents = [
        item for item in documents
        if item.get("confidence", 0) < 65 or not item.get("document_type_matches") or item.get("concerns")
    ]
    if uncertain_documents:
        reasons.append(f"{len(uncertain_documents)} document(s) need manual verification because of low confidence, a type mismatch, or AI concerns.")

    if reasons:
        return {
            "status": "manual_review_required",
            "title": "Manual verification is needed before assessing the requirements",
            "reasons": reasons,
        }

    return {
        "status": "appears_to_match",
        "title": "OCR suggests the configured requirements are met",
        "reasons": ["All configured eligibility checks passed and all required document types were detected."],
    }


def _admin_suggestion_summary(status):
    return {
        "requirements_not_met": "OCR suggests one or more configured requirements may not be met. Verify the cited evidence against the original documents.",
        "manual_review_required": "Some requirements or document details could not be confirmed from OCR. Review the original documents manually.",
        "appears_to_match": "OCR suggests the configured requirements may be met. Verify the original documents before making a decision.",
    }.get(status, "OCR review completed. Verify the original documents before making a decision.")


def _report_for_application(application_id: int, application_row):
    application = parse_application(application_row)
    rules = scheme_rules(application["scholarship_scheme"])
    with connect_database() as connection:
        documents = connection.execute(
            "SELECT * FROM application_documents WHERE application_id = ? ORDER BY created_at",
            (application_id,),
        ).fetchall()
    try:
        analysis = analyze_ocr_documents(application, documents, rules)
    except AIReviewUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error))

    required = (rules or {}).get("required_document_types", [])
    requested = application.get("missing_document_types", [])
    required = required if isinstance(required, list) else []
    requested = requested if isinstance(requested, list) else []
    required = list(dict.fromkeys(item for item in [*required, *requested] if item in DOCUMENT_TYPES))
    fields_by_name = {}
    findings_by_id = {item["document_id"]: item for item in analysis["documents"]}
    detected_types = set()
    for document in documents:
        finding = findings_by_id.get(document["id"])
        if finding and finding["confidence"] >= 65 and finding["detected_document_type"] in DOCUMENT_TYPES:
            detected_types.add(finding["detected_document_type"])
        elif document["document_type"] in DOCUMENT_TYPES:
            detected_types.add(document["document_type"])
    for finding in analysis["documents"]:
        for field in finding["extracted_fields"]:
            fields_by_name.setdefault(field["field"], []).append({**field, "document_id": finding["document_id"]})

    def numeric(value):
        if value is None:
            return None
        match = re.search(r"-?\d+(?:[.,]\d+)*", str(value).replace(" ", ""))
        if not match:
            return None
        try:
            return float(match.group(0).replace(",", ""))
        except ValueError:
            return None

    rule_fields = [
        ("minimum_percentage", "marks_percent", "minimum"),
        ("minimum_cgpa", "cgpa", "minimum"),
        ("minimum_attendance_percent", "attendance_percent", "minimum"),
        ("maximum_arrears", "arrears", "maximum"),
        ("maximum_annual_family_income", "annual_family_income", "maximum"),
    ]
    configured = (rules or {}).get("eligibility_rules", {})
    configured = configured if isinstance(configured, dict) else {}
    checks = []
    for rule_name, field_name, direction in rule_fields:
        threshold = configured.get(rule_name)
        if threshold is None:
            continue
        evidence_list = fields_by_name.get(field_name, [])
        chosen = next((item for item in evidence_list if numeric(item["value"]) is not None), None)
        if chosen and chosen["confidence"] < 65:
            chosen = None
        number = numeric(chosen["value"]) if chosen else None
        scale_number = None
        required_scale = numeric(configured.get("cgpa_scale")) if rule_name == "minimum_cgpa" else None
        if rule_name == "minimum_cgpa":
            scale_evidence = next(
                (item for item in fields_by_name.get("cgpa_scale", []) if item["confidence"] >= 65 and numeric(item["value"]) is not None),
                None,
            )
            scale_number = numeric(scale_evidence["value"]) if scale_evidence else None
        if number is not None and (
            (field_name in {"marks_percent", "attendance_percent"} and not 0 <= number <= 100)
            or (field_name in {"arrears", "annual_family_income", "cgpa", "cgpa_scale"} and number < 0)
        ):
            chosen = None
            number = None
        if rule_name == "minimum_cgpa":
            passed = None if number is None or scale_number is None or required_scale is None else (
                False if not math.isclose(scale_number, required_scale, abs_tol=0.001) or number > scale_number
                else number >= threshold
            )
        else:
            passed = None if number is None else number >= threshold if direction == "minimum" else number <= threshold
        checks.append({
            "rule": rule_name, "operator": direction, "threshold": threshold,
            "value": chosen["value"] if chosen else None,
            "evidence": chosen["evidence"] if chosen else None,
            "document_id": chosen["document_id"] if chosen else None,
            "confidence": chosen["confidence"] if chosen else None,
            **({"scale": scale_number, "required_scale": required_scale} if rule_name == "minimum_cgpa" else {}),
            "status": "undetermined" if passed is None else "passed" if passed else "failed",
        })

    required_category = configured.get("required_community_category")
    if isinstance(required_category, str) and required_category.strip():
        document_rows_by_id = {row["id"]: row for row in documents}
        category_evidence = []
        for item in fields_by_name.get("community_category", []):
            source = document_rows_by_id.get(item["document_id"])
            finding = findings_by_id.get(item["document_id"], {})
            is_community_certificate = bool(
                source and source["document_type"] == "community_certificate"
            ) or (
                finding.get("detected_document_type") == "community_certificate"
                and finding.get("confidence", 0) >= 65
            )
            if is_community_certificate and item["confidence"] >= 65:
                category_evidence.append(item)
        distinct_categories = {_community_category_key(item["value"]) for item in category_evidence}
        category_result = category_evidence[0] if len(distinct_categories) == 1 and category_evidence else None
        category_passed = (
            _community_category_key(category_result["value"]) == _community_category_key(required_category)
            if category_result else None
        )
        checks.append({
            "rule": "required_community_category",
            "operator": "matches",
            "threshold": required_category.strip(),
            "value": category_result["value"] if category_result else None,
            "evidence": category_result["evidence"] if category_result else None,
            "document_id": category_result["document_id"] if category_result else None,
            "confidence": category_result["confidence"] if category_result else None,
            "status": "undetermined" if category_passed is None else "passed" if category_passed else "failed",
        })

    documents_report = []
    for finding in analysis["documents"]:
        source = next(row for row in documents if row["id"] == finding["document_id"])
        documents_report.append({
            **finding,
            "uploaded_document_type": source["document_type"],
            "original_filename": source["original_filename"],
            "download_path": f"/applications/{application_id}/documents/{source['id']}",
            "admin_review_status": "pending_manual_verification",
        })
    missing = [item for item in required if item not in detected_types]
    unreadable_documents = [
        {
            "document_id": item["id"], "document_type": item["document_type"],
            "original_filename": item["original_filename"], "ocr_status": item["ocr_status"],
            "download_path": f"/applications/{application_id}/documents/{item['id']}",
        }
        for item in documents if item["id"] not in findings_by_id
    ]
    report = {
        "application_id": application_id,
        "scholarship": application["scholarship_scheme"],
        "model": analysis["model"],
        "summary": analysis["summary"],
        "generated_at": int(time.time()),
        "missing_document_types": missing,
        "checks": checks,
        "failed_checks": [item["rule"] for item in checks if item["status"] == "failed"],
        "undetermined_checks": [item["rule"] for item in checks if item["status"] == "undetermined"],
        "documents": documents_report,
        "unreadable_documents": unreadable_documents,
        "admin_suggestion": _admin_requirement_suggestion(checks, missing, documents_report, unreadable_documents),
        "manual_upload_documents": [
            {"document_type": item, "status": "missing" if item in missing else "uploaded", "upload_portal_action": "Download and upload manually after administrative review."}
            for item in required
        ],
        "official_decision": False,
        "documents_approved": False,
        "note": "AI suggestions based on OCR text only. Verify every finding against the original documents. An administrator must make the review decision; this is not an official eligibility or award decision.",
    }
    report["summary"] = _admin_suggestion_summary(report["admin_suggestion"]["status"])
    with connect_database() as connection:
        connection.execute(
            "INSERT INTO application_ai_reviews (application_id, report_json, model, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(application_id) DO UPDATE SET report_json = excluded.report_json, model = excluded.model, created_at = excluded.created_at",
            (application_id, json.dumps(report), analysis["model"], report["generated_at"]),
        )
    return report


def _saved_ai_report(application_id: int):
    with connect_database() as connection:
        row = connection.execute("SELECT report_json FROM application_ai_reviews WHERE application_id = ?", (application_id,)).fetchone()
    if row is None:
        return None
    report = json.loads(row["report_json"])
    if "admin_suggestion" not in report:
        report["admin_suggestion"] = _admin_requirement_suggestion(
            report.get("checks", []),
            report.get("missing_document_types", []),
            report.get("documents", []),
            report.get("unreadable_documents", []),
        )
    report["summary"] = _admin_suggestion_summary(report["admin_suggestion"]["status"])
    return report


@router.post("/applications/{application_id}/ai-review")
def create_student_ai_review(application_id: int, user=Depends(require_student)):
    return _report_for_application(application_id, fetch_owned_application(application_id, user))


@router.get("/applications/{application_id}/ai-review")
def get_student_ai_review(application_id: int, user=Depends(require_student)):
    fetch_owned_application(application_id, user)
    report = _saved_ai_report(application_id)
    if report is None:
        raise HTTPException(status_code=404, detail="No AI review is available yet")
    return report


@router.post("/admin/applications/{application_id}/ai-review")
def create_admin_ai_review(application_id: int, user=Depends(require_admin)):
    return _report_for_application(application_id, fetch_application_for_admin(application_id))


@router.get("/admin/applications/{application_id}/ai-review")
def get_admin_ai_review(application_id: int, user=Depends(require_admin)):
    fetch_application_for_admin(application_id)
    report = _saved_ai_report(application_id)
    if report is None:
        raise HTTPException(status_code=404, detail="No AI review is available yet")
    return report


@router.get("/applications")
def list_student_applications(user=Depends(require_student)):
    with connect_database() as connection:
        rows = connection.execute(
            "SELECT * FROM renewal_applications WHERE student_id = ? ORDER BY updated_at DESC",
            (user["id"],),
        ).fetchall()
    return {"applications": [parse_application(row) for row in rows]}


@router.post("/applications", status_code=status.HTTP_201_CREATED)
def create_draft(payload: ApplicationPayload, user=Depends(require_student)):
    if not payload.scholarship_scheme.strip():
        raise HTTPException(status_code=422, detail="Scholarship scheme is required")
    with connect_database() as connection:
        scholarship_row = connection.execute(
            "SELECT * FROM scholarships WHERE name = ? COLLATE NOCASE",
            (payload.scholarship_scheme.strip(),),
        ).fetchone()
    if scholarship_row:
        scholarship = parse_scholarship(scholarship_row)
        if not scholarship["is_active"]:
            raise HTTPException(status_code=404, detail="This scholarship is not currently open")
        if not meets_scholarship_cgpa(scholarship, get_student_academic_profile(user["id"])):
            raise HTTPException(status_code=403, detail="This scholarship is available only to students whose college CGPA record meets its requirement. Contact your college administrator if your record needs correction.")
    now = int(time.time())
    application_number = f"REN-{time.strftime('%Y', time.gmtime(now))}-{secrets.token_hex(4).upper()}"
    values = payload.model_dump()
    saved_profile = get_student_profile(user["id"])
    values["student_information"] = {
        **saved_profile,
        **{key: value for key, value in values["student_information"].items() if value not in (None, "")},
    }
    values["student_information"]["email"] = user["email"]
    try:
        with connect_database() as connection:
            cursor = connection.execute(
                """INSERT INTO renewal_applications
                (application_number, student_id, scholarship_scheme, renewal_year, application_type, status,
                 student_information, previous_scholarship, academic_details, financial_details,
                 declaration, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?)""",
                (application_number, user["id"], payload.scholarship_scheme.strip(), payload.renewal_year,
                 payload.application_type,
                 json.dumps(values["student_information"]), json.dumps(values["previous_scholarship"]),
                 json.dumps(values["academic_details"]), json.dumps(values["financial_details"]),
                 json.dumps(values["declaration"]), now, now),
            )
            row = connection.execute("SELECT * FROM renewal_applications WHERE id = ?", (cursor.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An application already exists for this scholarship and year")
    return parse_application(row)


@router.get("/applications/{application_id}")
def get_student_application(application_id: int, user=Depends(require_student)):
    row = fetch_owned_application(application_id, user)
    application = parse_application(row)
    with connect_database() as connection:
        documents = connection.execute(
            "SELECT * FROM application_documents WHERE application_id = ? ORDER BY created_at",
            (application_id,),
        ).fetchall()
    application["documents"] = [document_metadata(document) for document in documents]
    application["assessment"] = application_assessment(application, scheme_rules(application["scholarship_scheme"]))
    application["ai_review"] = _saved_ai_report(application_id)
    return application


@router.put("/applications/{application_id}")
def update_student_application(application_id: int, payload: ApplicationPayload, user=Depends(require_student)):
    row = fetch_owned_application(application_id, user)
    if row["status"] not in {"Draft", "Documents Required"}:
        raise HTTPException(status_code=409, detail="This application cannot be edited in its current status")
    if row["scholarship_scheme"] != payload.scholarship_scheme or row["renewal_year"] != payload.renewal_year:
        raise HTTPException(status_code=409, detail="Scheme and renewal year cannot be changed after draft creation")
    values = payload.model_dump()
    values["student_information"]["email"] = user["email"]
    now = int(time.time())
    with connect_database() as connection:
        connection.execute(
            """UPDATE renewal_applications SET application_type = ?, student_information = ?, previous_scholarship = ?,
               academic_details = ?, financial_details = ?, declaration = ?, updated_at = ? WHERE id = ? AND student_id = ?""",
            (payload.application_type, json.dumps(values["student_information"]), json.dumps(values["previous_scholarship"]),
             json.dumps(values["academic_details"]), json.dumps(values["financial_details"]),
             json.dumps(values["declaration"]), now, application_id, user["id"]),
        )
        save_student_profile(connection, user["id"], values["student_information"], now)
        connection.execute("DELETE FROM application_ai_reviews WHERE application_id = ?", (application_id,))
        updated = connection.execute("SELECT * FROM renewal_applications WHERE id = ?", (application_id,)).fetchone()
    return parse_application(updated)


@router.post("/applications/{application_id}/submit")
def submit_application(application_id: int, user=Depends(require_student)):
    row = fetch_owned_application(application_id, user)
    application = parse_application(row)
    if row["status"] not in {"Draft", "Documents Required"}:
        raise HTTPException(status_code=409, detail="This application cannot be submitted in its current status")
    errors = validation_errors(application)
    rules = scheme_rules(application["scholarship_scheme"])
    assessment = application_assessment(application, rules)
    eligibility_rules = (rules or {}).get("eligibility_rules", {})
    if isinstance(eligibility_rules, dict) and "minimum_cgpa" in eligibility_rules:
        profile_matches = meets_scholarship_cgpa(
            {"eligibility_rules": eligibility_rules},
            get_student_academic_profile(user["id"]),
        )
        cgpa_check = next(
            (check for check in assessment["eligibility_checks"]["checks"] if check["rule"] == "minimum_cgpa"),
            None,
        )
        if not profile_matches or (cgpa_check and not cgpa_check["passed"]):
            errors.append("Your CGPA and grading scale must meet the scholarship's configured minimum to submit.")
    if errors or assessment["missing_document_warnings"]:
        assessment["form_validation_errors"] = errors
        raise HTTPException(status_code=422, detail=assessment)
    now = int(time.time())
    next_status = "Resubmitted" if row["status"] == "Documents Required" else "Submitted"
    with connect_database() as connection:
        connection.execute(
            "UPDATE renewal_applications SET status = ?, submitted_at = ?, updated_at = ?, missing_documents = '[]' WHERE id = ? AND student_id = ?",
            (next_status, now, now, application_id, user["id"]),
        )
        updated = connection.execute("SELECT * FROM renewal_applications WHERE id = ?", (application_id,)).fetchone()
    return {"application": parse_application(updated), "assessment": assessment}


@router.post("/applications/{application_id}/documents", status_code=status.HTTP_201_CREATED)
def upload_document(application_id: int, payload: DocumentPayload, user=Depends(require_student)):
    row = fetch_owned_application(application_id, user)
    if row["status"] not in {"Draft", "Documents Required"}:
        raise HTTPException(status_code=409, detail="Documents cannot be added in this application status")
    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(status_code=422, detail="Document data must be valid base64")
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Document size must be between 1 and {MAX_UPLOAD_BYTES} bytes")
    signature, extension = DOCUMENT_SIGNATURES[payload.content_type]
    if not content.startswith(signature):
        raise HTTPException(status_code=415, detail="Document content does not match its declared PDF, JPEG, or PNG type")
    ocr_result = extract_document_text(content, payload.content_type)
    current_name = payload.original_filename.replace("\\", "/").split("/")[-1]
    safe_name = re.sub(r"[^A-Za-z0-9._ -]", "_", current_name).strip(" .")[:120] or f"document{extension}"
    storage_name = f"{secrets.token_hex(16)}{extension}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(UPLOAD_DIR, 0o700)
    except OSError:
        pass
    target_path = get_document_path(storage_name)
    temporary_path = UPLOAD_DIR / f".{storage_name}.tmp"
    try:
        temporary_path.write_bytes(content)
        try:
            os.chmod(temporary_path, 0o600)
        except OSError:
            pass
        with connect_database() as connection:
            count = connection.execute(
                "SELECT COUNT(*) AS count FROM application_documents WHERE application_id = ?", (application_id,)
            ).fetchone()["count"]
            if count >= MAX_FILES_PER_APPLICATION:
                raise HTTPException(status_code=413, detail=f"An application can contain at most {MAX_FILES_PER_APPLICATION} files")
            cursor = connection.execute(
                """INSERT INTO application_documents
                   (application_id, uploaded_by, document_type, original_filename, storage_name, content_type, size_bytes, created_at,
                    ocr_status, ocr_text, ocr_method, ocr_confidence, ocr_error)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (application_id, user["id"], payload.document_type, safe_name, storage_name, payload.content_type,
                 len(content), int(time.time()), ocr_result["ocr_status"], ocr_result["ocr_text"],
                 ocr_result["ocr_method"], ocr_result["ocr_confidence"], ocr_result["ocr_error"]),
            )
            os.replace(temporary_path, target_path)
            document_id = cursor.lastrowid
            connection.execute("DELETE FROM application_ai_reviews WHERE application_id = ?", (application_id,))
    except Exception:
        temporary_path.unlink(missing_ok=True)
        target_path.unlink(missing_ok=True)
        raise
    return {
        "id": document_id,
        "document_type": payload.document_type,
        "original_filename": safe_name,
        "content_type": payload.content_type,
        "size_bytes": len(content),
        "created_at": int(time.time()),
        "ocr_status": ocr_result["ocr_status"],
    }


def document_metadata(row):
    return {
        "id": row["id"],
        "document_type": row["document_type"],
        "original_filename": row["original_filename"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "created_at": row["created_at"],
        "ocr_status": row["ocr_status"],
    }


def admin_document_metadata(row):
    document = document_metadata(row)
    document.update({
        "ocr_text": row["ocr_text"],
        "ocr_method": row["ocr_method"],
        "ocr_confidence": row["ocr_confidence"],
        "ocr_error": row["ocr_error"],
    })
    return document


@router.post("/admin/applications/{application_id}/documents/{document_id}/ocr")
def rerun_document_ocr(application_id: int, document_id: int, user=Depends(require_admin)):
    fetch_application_for_admin(application_id)
    with connect_database() as connection:
        row = connection.execute(
            "SELECT * FROM application_documents WHERE id = ? AND application_id = ?",
            (document_id, application_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")
    path = get_document_path(row["storage_name"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Document file not found")
    ocr_result = extract_document_text(path.read_bytes(), row["content_type"])
    with connect_database() as connection:
        connection.execute(
            "UPDATE application_documents SET ocr_status = ?, ocr_text = ?, ocr_method = ?, ocr_confidence = ?, ocr_error = ? WHERE id = ?",
            (ocr_result["ocr_status"], ocr_result["ocr_text"], ocr_result["ocr_method"],
             ocr_result["ocr_confidence"], ocr_result["ocr_error"], document_id),
        )
        connection.execute("DELETE FROM application_ai_reviews WHERE application_id = ?", (application_id,))
        updated = connection.execute(
            "SELECT * FROM application_documents WHERE id = ?", (document_id,)
        ).fetchone()
    return admin_document_metadata(updated)


@router.get("/applications/{application_id}/documents")
def list_application_documents(application_id: int, user=Depends(current_user)):
    ensure_password_changed(user)
    if user["role"] == "student":
        fetch_owned_application(application_id, user)
    elif user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Account role cannot access documents")
    with connect_database() as connection:
        rows = connection.execute(
            "SELECT * FROM application_documents WHERE application_id = ? ORDER BY created_at",
            (application_id,),
        ).fetchall()
    return {"documents": [document_metadata(row) for row in rows]}


@router.get("/applications/{application_id}/documents/{document_id}")
def download_application_document(
    application_id: int,
    document_id: int,
    preview: bool = Query(default=False),
    user=Depends(current_user),
):
    ensure_password_changed(user)
    if user["role"] == "student":
        fetch_owned_application(application_id, user)
    elif user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Account role cannot access documents")
    with connect_database() as connection:
        row = connection.execute(
            "SELECT * FROM application_documents WHERE id = ? AND application_id = ?",
            (document_id, application_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")
    path = get_document_path(row["storage_name"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Document file not found")
    return FileResponse(
        path,
        media_type=row["content_type"],
        filename=row["original_filename"],
        content_disposition_type="inline" if preview else "attachment",
    )


@router.get("/admin/applications")
def list_admin_applications(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    application_status: Optional[str] = Query(default=None, alias="status"),
    user=Depends(require_admin),
):
    if application_status and application_status not in APPLICATION_STATUSES:
        raise HTTPException(status_code=422, detail="Unknown application status")
    conditions = []
    parameters = []
    if application_status:
        conditions.append("status = ?")
        parameters.append(application_status)
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    with connect_database() as connection:
        total = connection.execute(f"SELECT COUNT(*) AS count FROM renewal_applications {where_clause}", parameters).fetchone()["count"]
        rows = connection.execute(
            f"SELECT * FROM renewal_applications {where_clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            [*parameters, per_page, (page - 1) * per_page],
        ).fetchall()
    return {"applications": [parse_application(row) for row in rows], "page": page, "per_page": per_page, "total": total}


@router.get("/admin/applications/{application_id}")
def get_admin_application(application_id: int, user=Depends(require_admin)):
    row = fetch_application_for_admin(application_id)
    application = parse_application(row)
    rules = scheme_rules(application["scholarship_scheme"])
    assessment = application_assessment(application, rules)
    with connect_database() as connection:
        owner = connection.execute("SELECT id, email, created_at FROM users WHERE id = ?", (row["student_id"],)).fetchone()
        documents = connection.execute(
            "SELECT * FROM application_documents WHERE application_id = ? ORDER BY created_at", (application_id,)
        ).fetchall()
    application["student"] = dict(owner)
    application["documents"] = [admin_document_metadata(document) for document in documents]
    application["assessment"] = assessment
    application["ai_review"] = _saved_ai_report(application_id)
    return application


@router.patch("/admin/applications/{application_id}/review")
def review_application(application_id: int, payload: ReviewPayload, user=Depends(require_admin)):
    row = fetch_application_for_admin(application_id)
    if payload.status not in ADMIN_TRANSITIONS.get(row["status"], set()):
        raise HTTPException(status_code=409, detail=f"Cannot change status from {row['status']} to {payload.status}")
    if payload.status != "Documents Required" and payload.missing_document_types:
        raise HTTPException(status_code=422, detail="Missing document requests require the Documents Required status")
    now = int(time.time())
    with connect_database() as connection:
        connection.execute(
            "UPDATE renewal_applications SET status = ?, admin_feedback = ?, missing_documents = ?, updated_at = ? WHERE id = ?",
            (payload.status, payload.feedback.strip(), json.dumps(payload.missing_document_types), now, application_id),
        )
        updated = connection.execute("SELECT * FROM renewal_applications WHERE id = ?", (application_id,)).fetchone()
    return parse_application(updated)
