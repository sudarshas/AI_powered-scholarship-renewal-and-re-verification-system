import os
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

from auth import router as auth_router
from applications import router as applications_router
from document_ocr import runtime_status as ocr_runtime_status
from ai_review import runtime_status as ai_review_runtime_status

IS_PRODUCTION = os.environ.get("APP_ENV", "development").strip().lower() == "production"
app = FastAPI(
    title="Scholarship AI Service",
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)
app.include_router(auth_router)
app.include_router(applications_router)

RequiredDocument = Literal["marksheet", "attendance_report", "income_certificate"]


@app.get("/health")
def health_check():
    return {"service": "scholarship-ai-service", "status": "ok", "ocr": ocr_runtime_status(), "ai_review": ai_review_runtime_status()}


class DemoRenewalCheck(BaseModel):
    previous_year_marks_percent: float = Field(ge=0, le=100)
    attendance_percent: float = Field(ge=0, le=100)
    annual_family_income: float = Field(ge=0)
    document_types: list[RequiredDocument] = Field(default_factory=list)


@app.post("/renewal/check")
def check_demo_renewal(application: DemoRenewalCheck):
    required_documents = ["marksheet", "attendance_report", "income_certificate"]
    missing_documents = [
        document for document in required_documents
        if document not in application.document_types
    ]
    checks = {
        "previous_year_marks": {
            "required_percent": 60,
            "provided_percent": application.previous_year_marks_percent,
            "passed": application.previous_year_marks_percent >= 60,
        },
        "attendance": {
            "required_percent": 75,
            "provided_percent": application.attendance_percent,
            "passed": application.attendance_percent >= 75,
        },
        "annual_family_income": {
            "maximum_amount": 300000,
            "provided_amount": application.annual_family_income,
            "currency": "INR",
            "passed": application.annual_family_income <= 300000,
        },
        "required_documents": {
            "required_types": required_documents,
            "provided_types": application.document_types,
            "passed": not missing_documents,
        },
    }
    failed_checks = [name for name, check in checks.items() if not check["passed"]]

    return {
        "scholarship": "Fictional Demo Scholarship",
        "screening_result": "meets_demo_checks" if not failed_checks else "does_not_meet_demo_checks",
        "meets_demo_checks": not failed_checks,
        "checks": checks,
        "failed_checks": failed_checks,
        "missing_document_types": missing_documents,
        "demo_rules": True,
        "official_decision": False,
        "note": "These are fictional demo rules. This result is not an official scholarship eligibility or award decision.",
    }
