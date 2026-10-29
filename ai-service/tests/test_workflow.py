import base64
import json
import os
import sys
import tempfile
import unittest
import importlib
from pathlib import Path
from unittest.mock import patch

import httpx

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))
_bootstrap = tempfile.TemporaryDirectory(prefix="scholarship-tests-")
os.environ["DATABASE_PATH"] = str(Path(_bootstrap.name) / "bootstrap.sqlite")
os.environ["UPLOAD_DIR"] = str(Path(_bootstrap.name) / "bootstrap-uploads")
os.environ["SESSION_COOKIE_SECURE"] = "false"

import applications
import auth
import main


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver")


def valid_application(email, year=2027, scheme="Fictional Test Scheme"):
    return {
        "scholarship_scheme": scheme,
        "renewal_year": year,
        "student_information": {
            "full_name": "Demo Student",
            "college_registration_number": "TEST-REG-104",
            "email": email,
            "mobile_number": "+91 90000 00000",
            "college_name": "Example Test College",
            "department_or_course": "Computer Science",
            "current_year_of_study": "2",
        },
        "previous_scholarship": {
            "previous_application_reference": "DEMO-REF-1",
            "previous_scholarship_academic_year": "2025-26",
        },
        "academic_details": {
            "previous_marks_or_cgpa": 8.1,
            "maximum_marks_or_grading_scale": 10,
            "percentage": 81,
            "arrears": 0,
            "current_semester_or_academic_year": "Semester 3",
        },
        "financial_details": {
            "annual_family_income": 250000,
            "income_certificate_details": "Synthetic test metadata only",
            "other_scheme_specific_fields": "",
        },
        "declaration": {"confirmed": True},
    }


class WorkflowApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scholarship-case-")
        auth.DATABASE_PATH = Path(self.temp.name) / "accounts.sqlite"
        applications.UPLOAD_DIR = Path(self.temp.name) / "private-files"
        applications.MAX_UPLOAD_BYTES = 1024
        applications.MAX_FILES_PER_APPLICATION = 8
        auth.initialize_database()
        applications.initialize_application_tables()
        self.http = client()

    async def asyncTearDown(self):
        await self.http.aclose()
        self.temp.cleanup()

    async def register_student(self, email="student@example.test"):
        response = await self.http.post("/auth/register", json={
            "email": email,
            "password": "fake-demo-password-42",
            "role": "admin",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["role"], "student")
        return response.json()

    async def create_draft(self, email="student@example.test", year=2027, scheme="Fictional Test Scheme"):
        response = await self.http.post("/applications", json={
            "scholarship_scheme": scheme,
            "renewal_year": year,
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    async def test_registration_login_logout_hashes_and_private_student_route(self):
        user = await self.register_student()
        response = await self.http.get("/students/me")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["student"]["id"], user["id"])
        with auth.connect_database() as connection:
            stored = connection.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()[0]
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertNotIn("fake-demo-password-42", stored)

        await self.http.post("/auth/logout")
        self.assertEqual((await self.http.get("/students/me")).status_code, 401)
        login = await self.http.post("/auth/login", json={"email": user["email"], "password": "fake-demo-password-42"})
        self.assertEqual(login.status_code, 200)
        self.assertEqual((await self.http.get("/auth/me")).json()["role"], "student")
        bad_login = await self.http.post("/auth/login", json={"email": user["email"], "password": "wrong-password"})
        self.assertEqual(bad_login.status_code, 401)

    async def test_student_draft_duplicate_validation_upload_and_submit(self):
        await self.register_student()
        draft = await self.create_draft()
        duplicate = await self.http.post("/applications", json={
            "scholarship_scheme": "Fictional Test Scheme", "renewal_year": 2027,
        })
        self.assertEqual(duplicate.status_code, 409)
        forbidden_fields = await self.http.post("/applications", json={
            "scholarship_scheme": "Different Test Scheme", "renewal_year": 2028, "student_id": 999, "status": "Verified",
        })
        self.assertEqual(forbidden_fields.status_code, 422)

        config = {"Fictional Test Scheme": {
            "required_document_types": ["marksheet"],
            "eligibility_rules": {
                "minimum_percentage": 60,
                "maximum_arrears": 0,
                "maximum_annual_family_income": 300000,
            },
        }}
        with patch.dict(os.environ, {"SCHEME_RULES_JSON": json.dumps(config)}):
            empty_submit = await self.http.post(f"/applications/{draft['id']}/submit")
            self.assertEqual(empty_submit.status_code, 422)
            errors = empty_submit.json()["detail"]["form_validation_errors"]
            self.assertIn("student_information.full_name is required", errors)

            application = valid_application("student@example.test")
            application["declaration"]["confirmed"] = False
            saved = await self.http.put(f"/applications/{draft['id']}", json=application)
            self.assertEqual(saved.status_code, 200)
            missing_doc = await self.http.post(f"/applications/{draft['id']}/submit")
            self.assertEqual(missing_doc.status_code, 422)
            self.assertEqual(missing_doc.json()["detail"]["missing_document_warnings"], ["marksheet"])

            invalid_file = {
                "document_type": "marksheet", "original_filename": "fake.pdf",
                "content_type": "application/pdf", "content_base64": base64.b64encode(b"not a pdf").decode(),
            }
            invalid_upload = await self.http.post(f"/applications/{draft['id']}/documents", json=invalid_file)
            self.assertEqual(invalid_upload.status_code, 415)
            bad_base64 = {**invalid_file, "content_base64": "not-base64!"}
            self.assertEqual((await self.http.post(f"/applications/{draft['id']}/documents", json=bad_base64)).status_code, 422)
            applications.MAX_UPLOAD_BYTES = 8
            too_large = {**invalid_file, "content_base64": base64.b64encode(b"%PDF-" + b"x" * 20).decode()}
            oversized_upload = await self.http.post(f"/applications/{draft['id']}/documents", json=too_large)
            self.assertEqual(oversized_upload.status_code, 413)
            applications.MAX_UPLOAD_BYTES = 1024

            valid_pdf = {**invalid_file, "content_base64": base64.b64encode(b"%PDF-1.7\nsynthetic document fixture").decode()}
            uploaded = await self.http.post(f"/applications/{draft['id']}/documents", json=valid_pdf)
            self.assertEqual(uploaded.status_code, 201, uploaded.text)
            self.assertNotIn("private-files", uploaded.text)
            metadata = await self.http.get(f"/applications/{draft['id']}/documents")
            self.assertEqual(metadata.status_code, 200)
            document_id = metadata.json()["documents"][0]["id"]
            download = await self.http.get(f"/applications/{draft['id']}/documents/{document_id}")
            self.assertEqual(download.content[:5], b"%PDF-")
            application["declaration"]["confirmed"] = True
            await self.http.put(f"/applications/{draft['id']}", json=application)
            submitted = await self.http.post(f"/applications/{draft['id']}/submit")
            self.assertEqual(submitted.status_code, 200, submitted.text)
            self.assertEqual(submitted.json()["application"]["status"], "Submitted")
            self.assertTrue(submitted.json()["assessment"]["eligibility_checks"]["configured"])
            self.assertEqual(submitted.json()["assessment"]["eligibility_checks"]["checks"][0]["passed"], True)
            locked = await self.http.put(f"/applications/{draft['id']}", json=application)
            self.assertEqual(locked.status_code, 409)

    async def test_student_cannot_read_another_students_application(self):
        first = await self.register_student("first@example.test")
        draft = await self.create_draft("first@example.test", 2027)
        upload = await self.http.post(f"/applications/{draft['id']}/documents", json={
            "document_type": "marksheet",
            "original_filename": "synthetic.pdf",
            "content_type": "application/pdf",
            "content_base64": base64.b64encode(b"%PDF-1.7 synthetic access fixture").decode(),
        })
        self.assertEqual(upload.status_code, 201)
        document_id = upload.json()["id"]
        await self.http.post("/auth/logout")
        second = await self.register_student("second@example.test")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual((await self.http.get(f"/applications/{draft['id']}")).status_code, 404)
        update = await self.http.put(f"/applications/{draft['id']}", json=valid_application("second@example.test"))
        self.assertEqual(update.status_code, 404)
        foreign_upload = await self.http.get(f"/applications/{draft['id']}/documents")
        self.assertEqual(foreign_upload.status_code, 404)
        foreign_download = await self.http.get(f"/applications/{draft['id']}/documents/{document_id}")
        self.assertEqual(foreign_download.status_code, 404)
        no_session = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver")
        try:
            self.assertEqual((await no_session.get("/applications")).status_code, 401)
            self.assertEqual((await no_session.get("/admin/applications")).status_code, 401)
        finally:
            await no_session.aclose()

    async def test_admin_pagination_review_transitions_and_student_resubmission(self):
        student = await self.register_student()
        draft = await self.create_draft()
        application = valid_application(student["email"])
        await self.http.put(f"/applications/{draft['id']}", json=application)
        await self.create_draft(year=2028)
        payload = {
            "document_type": "marksheet", "original_filename": "mock.pdf",
            "content_type": "application/pdf", "content_base64": base64.b64encode(b"%PDF-1.7 synthetic").decode(),
        }
        await self.http.post(f"/applications/{draft['id']}/documents", json=payload)
        submitted = await self.http.post(f"/applications/{draft['id']}/submit")
        self.assertEqual(submitted.status_code, 200)

        await self.http.post("/auth/logout")
        admin = auth.create_admin_account("admin@example.test", "fake-admin-password-77")
        logged_in = await self.http.post("/auth/login", json={"email": admin["email"], "password": "fake-admin-password-77"})
        self.assertEqual(logged_in.status_code, 200)
        self.assertEqual((await self.http.get("/applications")).status_code, 403)
        self.assertEqual((await self.http.get("/students/me")).status_code, 403)
        listing = await self.http.get("/admin/applications?page=1&per_page=1&status=Submitted")
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["total"], 1)
        all_apps_page = await self.http.get("/admin/applications?page=1&per_page=1")
        self.assertEqual(all_apps_page.json()["total"], 2)
        next_page = await self.http.get("/admin/applications?page=2&per_page=1")
        self.assertEqual(len(next_page.json()["applications"]), 1)
        detail = await self.http.get(f"/admin/applications/{draft['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(len(detail.json()["documents"]), 1)

        reviewed = await self.http.patch(f"/admin/applications/{draft['id']}/review", json={
            "status": "Under Review", "feedback": "Please provide one more synthetic document.",
        })
        self.assertEqual(reviewed.status_code, 200)
        requested = await self.http.patch(f"/admin/applications/{draft['id']}/review", json={
            "status": "Documents Required", "feedback": "Bonafide certificate requested.",
            "missing_document_types": ["bonafide_certificate"],
        })
        self.assertEqual(requested.status_code, 200)
        invalid_transition = await self.http.patch(f"/admin/applications/{draft['id']}/review", json={
            "status": "Draft", "feedback": "invalid transition",
        })
        self.assertEqual(invalid_transition.status_code, 409)

        await self.http.post("/auth/logout")
        await self.http.post("/auth/login", json={"email": student["email"], "password": "fake-demo-password-42"})
        returned_detail = await self.http.get(f"/applications/{draft['id']}")
        self.assertEqual(returned_detail.json()["admin_feedback"], "Bonafide certificate requested.")
        self.assertEqual(returned_detail.json()["assessment"]["missing_document_warnings"], ["bonafide_certificate"])
        extra_doc = {**payload, "document_type": "bonafide_certificate", "original_filename": "mock-bonafide.pdf"}
        self.assertEqual((await self.http.post(f"/applications/{draft['id']}/documents", json=extra_doc)).status_code, 201)
        resubmitted = await self.http.post(f"/applications/{draft['id']}/submit")
        self.assertEqual(resubmitted.status_code, 200, resubmitted.text)
        self.assertEqual(resubmitted.json()["application"]["status"], "Resubmitted")

        await self.http.post("/auth/logout")
        await self.http.post("/auth/login", json={"email": admin["email"], "password": "fake-admin-password-77"})
        verified = await self.http.patch(f"/admin/applications/{draft['id']}/review", json={
            "status": "Verified", "feedback": "Administrative verification complete.",
        })
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.json()["status"], "Verified")

    async def test_health_validation_and_persistence_after_service_reload(self):
        user = await self.register_student()
        bad_payload = await self.http.post("/renewal/check", json={
            "previous_year_marks_percent": -1,
            "attendance_percent": 80,
            "annual_family_income": 100,
        })
        self.assertEqual(bad_payload.status_code, 422)
        draft = await self.create_draft()
        self.assertEqual((await self.http.get("/health")).json()["status"], "ok")
        cookie = self.http.cookies.get(auth.SESSION_COOKIE)
        await self.http.aclose()
        os.environ["DATABASE_PATH"] = str(auth.DATABASE_PATH)
        os.environ["UPLOAD_DIR"] = str(applications.UPLOAD_DIR)
        importlib.reload(auth)
        importlib.reload(applications)
        importlib.reload(main)
        restarted_client = client()
        restarted_client.cookies.set(auth.SESSION_COOKIE, cookie)
        try:
            response = await restarted_client.get("/applications")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["applications"][0]["id"], draft["id"])
            self.assertEqual(
                response.json()["applications"][0]["student_information"],
                {"email": "student@example.test"},
            )
            account = await restarted_client.get("/auth/me")
            self.assertEqual(account.json()["id"], user["id"])
        finally:
            await restarted_client.aclose()


if __name__ == "__main__":
    unittest.main()
