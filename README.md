# Scholarship AI System

A scholarship workflow project with a React frontend, an Express backend, and a FastAPI service. Its optional OCR-based AI review uses Ollama and remains advisory.

## Requirements

- Node.js 22.13 or newer and npm 10 or newer
- Python 3.11 or newer and pip

## Start the frontend

Open a terminal in `frontend`, then run:

```sh
npm install
npm run dev
```

The frontend runs at `http://127.0.0.1:5174`.

## Start the backend

Open another terminal in `backend`, then run:

```sh
npm install
npm run dev
```

The API listens at `http://localhost:3000`. Its health check is `http://localhost:3000/api/health`; Express forwards this request to FastAPI's existing `/health` route and includes the Python service status in its response. The first renewal screening route is `POST /api/renewal/check`; Express forwards it to FastAPI's `POST /renewal/check`. Set the backend environment variable `AI_SERVICE_URL` to the Python service base URL if it is not `http://localhost:8000`.

## Fictional demo renewal screening

`POST /api/renewal/check` evaluates mock rules for a fictional demo scholarship. It checks previous-year marks of at least 60%, attendance of at least 75%, annual family income no more than Rs. 300,000, and the presence of `marksheet`, `attendance_report`, and `income_certificate` document types. The request supplies document types as ordinary JSON strings; this endpoint does not accept uploaded files. FastAPI validates the numeric fields and allowed document type values, and Express forwards FastAPI's response. Results identify each check, any failed checks, and any missing document types. These are demo rules and the result is not an official scholarship eligibility or award decision.

Send this sample JSON to `http://localhost:3000/api/renewal/check`:

```json
{
  "previous_year_marks_percent": 68,
  "attendance_percent": 82,
  "annual_family_income": 250000,
  "document_types": ["marksheet", "attendance_report", "income_certificate"]
}
```

## Student and admin accounts

Accounts and sessions are stored in a local SQLite database. Passwords are stored as scrypt hashes. Sign-in uses a random, server-side session and an HTTP-only, SameSite=Lax cookie; the cookie is marked `Secure` by default. Students cannot register themselves: an admin creates student accounts using the college-issued email address and roll number. The roll number is hashed as the temporary password, and the student must change it to a password of at least 12 characters on first sign-in before using account features. Admin accounts are created only through the seed process. The student account endpoint returns only the signed-in student's own account information at `GET /api/students/me`.

The FastAPI service reads these environment variables:

- `DATABASE_PATH` (optional): SQLite file path. By default it uses `ai-service/scholarship.db`.
- `SESSION_COOKIE_SECURE` (optional): defaults to `true`. Keep it `true` when serving over HTTPS. For local HTTP development only, set it to `false` before starting FastAPI so the browser will send the cookie.
- `SCHEME_RULES_JSON` (optional): JSON object of per-scheme eligibility rules for applications. Required document lists come from active scholarships configured by an admin in the portal.
- `UPLOAD_DIR` (optional): private file storage directory; defaults to `ai-service/private-uploads/`.
- `MAX_UPLOAD_BYTES` (optional): per-file byte limit; defaults to 10 MiB. Configure the same limit in Express and FastAPI.
- `MAX_FILES_PER_APPLICATION` (optional): upload count limit per application; defaults to 8.
- `TESSERACT_CMD` (optional): full path to `tesseract.exe` when it is not on PATH.
- `OCR_LANGUAGE` (optional): Tesseract language code; defaults to `eng`.
- `OCR_TIMEOUT_SECONDS` (optional): OCR time limit per document; defaults to 45 seconds.
- `MAX_OCR_PAGES` (optional): maximum PDF pages processed; defaults to 10.
- `ALLOWED_ORIGINS` (Express, optional): comma-separated frontend origins allowed by CORS and mutation-origin checks.
- `AI_SERVICE_URL` (Express, optional): FastAPI base URL; defaults to `http://localhost:8000`.
- `PORT` (Express, optional): HTTP port; defaults to `3000`.
- `OLLAMA_BASE_URL` (FastAPI, optional): Ollama API base URL; defaults to `http://127.0.0.1:11434`. For deployment, use the private network URL reachable from FastAPI.
- `OLLAMA_MODEL` (FastAPI, optional): exact installed model tag; defaults to `llama3.2:1b`.
- `OLLAMA_API_KEY` (FastAPI, optional): bearer token when a trusted reverse proxy in front of Ollama requires one. Keep it in the host's secret manager/environment; do not commit it.
- `OLLAMA_TIMEOUT_SECONDS` (FastAPI, optional): maximum time for one document analysis; defaults to `180`.

Student CGPA records are stored in the `student_academic_profiles` table in the same SQLite database as accounts and scholarships. Reusable personal and college details are stored separately in the `student_profiles` table in that database. By default, this is `ai-service/scholarship.db`; setting `DATABASE_PATH` changes the location. Only administrators can create or update CGPA records. Students can see their own saved CGPA, but cannot edit it. The student scholarship catalogue uses the stored CGPA and the scholarship's minimum CGPA and scale to decide visibility.

### Deployment layout

The app services can be deployed separately, but they must be configured to reach each other. Set Express `AI_SERVICE_URL` to the deployed FastAPI private service URL, and set FastAPI `OLLAMA_BASE_URL` to the Ollama server's private API URL. Do not use `localhost` for a different host or container: it always refers to the current service's own machine/container. Set `OLLAMA_MODEL` to the exact installed model tag. For a split frontend/API deployment, `VITE_API_BASE_URL` is baked in at build time and must point to the public HTTPS URL of Express; allow the exact frontend origin in Express `ALLOWED_ORIGINS` and configure a cookie policy supported by both domains. The bundled single-host deployment keeps the frontend and API on the same HTTPS origin and uses a relative API URL.

Run Ollama on a machine with enough memory/compute and keep its API private behind a firewall/private network. Ollama's local API does not provide authentication by default; do not expose it publicly. If FastAPI reaches it across hosts, use a private network or a trusted TLS/authentication reverse proxy and set `OLLAMA_API_KEY` when that proxy requires a bearer token. Do not send student documents to an unapproved third party. For production, serve the web app and APIs over HTTPS and keep `SESSION_COOKIE_SECURE=true`.

The current app stores accounts/applications in SQLite and private uploads on disk. A first deployment should use one persistent FastAPI instance with durable volumes configured through `DATABASE_PATH` and `UPLOAD_DIR`; ephemeral local files will be lost when a host restarts or redeploys. This storage setup is not suitable for horizontally scaled production. Before running multiple API instances or handling substantial real student usage, migrate SQLite to a managed database and private uploads to shared object storage.

### Single-host Docker deployment

The repository includes a Docker Compose deployment for one Linux host. Caddy terminates HTTPS and routes the browser and `/api` traffic on the same origin. Express and FastAPI are private to the Docker network. SQLite, uploaded files, and Caddy certificates use persistent named volumes. Container logs have a bounded local rotation policy. This is a single-instance deployment; it does not provide horizontal scaling.

Prerequisites: Docker Engine with Compose, a domain whose DNS points to the host, inbound TCP ports 80 and 443, and an Ollama server reachable through a private network with `OLLAMA_MODEL` already installed. Do not expose the Ollama API publicly. On the host:

```sh
cp deploy/production.env.example .env.production
```

Edit `.env.production`: set `APP_DOMAIN` to your real domain and `OLLAMA_BASE_URL` to the private Ollama URL. Keep this file out of source control and restrict its permissions. The example leaves `VITE_API_BASE_URL` blank so the browser uses the same HTTPS origin. Do not set `SESSION_COOKIE_SECURE=false` in production.

Validate the Compose configuration and launch the services:

```sh
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

Create the first administrator interactively; do not place the password in a command or environment file:

```sh
docker compose --env-file .env.production exec ai-service python seed_admin.py admin@your-real-domain.edu
```

Check `https://your-domain/api/health` and confirm `ai_review.available` is `true`. For service logs, run `docker compose --env-file .env.production logs -f`. Caddy obtains and renews the HTTPS certificate when DNS and ports are configured correctly.

To make an encrypted backup, install `age` on the host and create a recipient key pair with `age-keygen`; keep the private key offline. Use a separately mounted, encrypted backup volume and run `bash deploy/backup.sh /absolute/path/to/backup-volume <age-public-recipient>`. The script uses SQLite's online backup API, includes uploaded files, encrypts the archive, and removes its temporary plaintext copies on exit. Schedule it with the host's scheduler, copy archives off-host, and test restoring both the database and uploads before storing real student records. Keep the backup volume and its scratch space encrypted because they briefly contain plaintext while the archive is assembled. The Compose file starts one FastAPI process because SQLite is local to this host. For multiple instances or higher traffic, migrate to managed PostgreSQL and private shared object storage, add shared rate limiting and background OCR/AI jobs, then deploy using the chosen provider's managed services.

### Render deployment

The repository also includes a Render Blueprint in `render.yaml`. It creates a public portal service and two private services for Express and FastAPI. The portal serves the React build and proxies `/api` over Render's private network, so browser requests and the HTTP-only sign-in cookie stay on one origin. The Blueprint places services in Singapore and gives FastAPI a 10 GB persistent disk mounted at `/data` for SQLite and uploaded documents. Change the region in all three service entries before the first deployment if another Render region is preferable; Render does not let a service change regions after creation.

To deploy, push this repository to GitHub, select **New → Blueprint** in Render, connect the repository, and apply `render.yaml`. Set the prompted `OLLAMA_BASE_URL` to an Ollama API endpoint reachable from the Render private service network; set `OLLAMA_MODEL` if you use a different model tag. Ollama is not included in this Blueprint. A model server on a personal computer will be unavailable whenever it is offline or unreachable from Render; use an always-on server and keep its API private on the Render network or protect an external endpoint with HTTPS and authentication. If you attach a custom domain, update `ALLOWED_ORIGINS` on the Express service to that exact HTTPS origin. Keep the FastAPI disk-backed service at one instance. Render documents that persistent disks are paid, single-instance storage, and that disk-backed services have downtime during redeploys. Existing local accounts, scholarships, and uploads are not copied to Render; migrate them separately if you need them. Use the `/api/health` endpoint after deployment, then create the first admin from the FastAPI service shell with `python seed_admin.py admin@your-domain.edu`; the command prompts for a password and stores only its hash. See [Render's Blueprint reference](https://render.com/docs/blueprint-spec), [persistent disk guidance](https://render.com/docs/disks), and [health-check behavior](https://render.com/docs/health-checks).

For Windows PowerShell local development, open the `ai-service` directory, activate its virtual environment, then set the development cookie option and start FastAPI:

```powershell
$env:SESSION_COOKIE_SECURE = "false"
uvicorn main:app --reload --port 8000
```

Set up a demo admin account from another terminal in `ai-service`, with the same Python virtual environment active:

```powershell
python seed_admin.py admin@example.test
```

The script prompts for the password twice and stores only its hash. It creates an admin account directly in the database; admin accounts cannot be created through the portal. Do not put passwords in shell commands, source files, or the README.

Start the Express backend and Vite frontend as described below. Sign in as an admin with the seeded email and password, then open **Student accounts** in the admin workspace. Enter the student's college email and roll number to create their account. Share the email and initial roll-number password directly with that student. Students sign in using those details and must choose a new password before proceeding. Later they sign in with the new password. Both roles can sign out using **Sign out**. Students see their own applications; admins see the review workspace.

## Scholarship application workflow

Signed-in students see their profile with application and distinct-scholarship counts, active scholarship cards, and their application history. When starting an application, students choose **First-time scholarship application** or **Scholarship renewal**. Previous scholarship reference and academic-year details are required only for renewals. Personal and college details entered in an application are saved to the student's `student_profiles` record when they continue from the first form step or save the draft. Future applications are prefilled with those details; students can edit them when something changes. Existing application details are used to initialize profiles the first time the service starts with this update. Admins create scholarship cards with a name, description, and required document types. Selecting a card shows its requirements and documents the student has uploaded to applications for that scholarship. Students can start drafts from the catalogue, edit drafts or applications returned as **Documents Required**, upload supporting files, review a summary, and submit with an explicit declaration. Submitted applications are locked for student edits until an administrator requests corrections. Students cannot set their own status or choose an owner ID; the API takes ownership from the session cookie.

Signed-in admins can filter and paginate applications, review the details and private files, request documents, leave feedback, and make permitted status transitions. The workflow uses `Draft`, `Submitted`, `Under Review`, `Documents Required`, `Resubmitted`, `Verified`, and `Rejected`. A submitted application is not scholarship approval.

The admin dashboard also shows five fictional sample scholarships with two demo students each. Click a sample count and then a name to inspect mock details and placeholder document names. Accept/reject actions in this sample panel only change its demo display state; they do not create accounts, upload files, or update real applications. Real applications are listed separately below: select a student's name to inspect their saved details and private documents, then accept or reject using the admin actions.

No scheme-specific eligibility thresholds are configured by default. The assessment reports that those rules are unconfigured and marks academic and financial information for administrative verification. Set `SCHEME_RULES_JSON` in the FastAPI environment to configure rules by exact scheme name, or set the optional rules while an admin creates a scholarship in the portal. Supported keys are `minimum_percentage`, `minimum_cgpa` with its matching `cgpa_scale`, `minimum_attendance_percent`, `maximum_arrears`, `maximum_annual_family_income`, and `required_community_category`. Community category is scholarship-specific; when set, a community certificate is required. Admin-defined required document types are stored with each scholarship and shown to students in its detail view. For example, fictional-only eligibility configuration in PowerShell can look like:

```powershell
$env:SCHEME_RULES_JSON = '{"Fictional Showcase Grant":{"required_document_types":["community_certificate"],"eligibility_rules":{"minimum_percentage":60,"maximum_arrears":0,"required_community_category":"BC"}}}'
```

This is mock configuration and does not describe a real scholarship. Leave rules unconfigured unless you have an authorized scheme specification.

For CGPA-filtered scholarships, admins set a minimum CGPA and its grading-scale maximum in the scholarship form, then maintain each student's official CGPA in **College CGPA records**. The student catalogue returns CGPA-filtered scholarships only when the college-managed CGPA meets the cutoff on the same scale; the API also rejects attempts to start an application for a scholarship that is not available to that student. The CGPA check only controls scholarship visibility and is not an award decision.

To add fictional CGPA values for existing demo students whose email ends in `@example.test`, activate the Python environment in `ai-service` and run:

```powershell
python seed_cgpa.py
```

The script writes sample values to `student_academic_profiles` in the configured database and never overwrites accounts outside the `@example.test` demo domain. Use **College CGPA records** in the admin page to set or correct a student's record. Do not use the sample values for real students.

### OCR-based AI review (advisory)

Students can run **Check OCR text against requirements** on an application; admins can run **Analyze OCR and prepare review list**. FastAPI selects OCR lines relevant to the configured scholarship checks and uploaded document types, then sends excerpts capped at 1,200 characters per document and 4,800 characters for a review to Ollama's chat API. It requests a compact structured extraction of document type, candidate eligibility values, short evidence snippets, confidence, and concerns. Locally, Ollama can run on the same computer. After deployment, run Ollama on a model server reachable from FastAPI; the student's browser never connects directly to Ollama. Set `OLLAMA_BASE_URL` and `OLLAMA_MODEL` in FastAPI's environment. The model does not verify authenticity, approve files, or make scholarship decisions. Configured numeric thresholds are compared by application code; low-confidence and absent values remain undetermined.

The admin report includes an advisory requirement suggestion based on the selected scholarship's configured checks and document list. Numeric findings and community category findings are checked against their OCR evidence before they are used. For a community requirement, set the scholarship's **Required community category** (for example `BC`) in the admin scholarship settings; this also requires students to upload a community certificate. The AI extracts the category only when it is clearly printed, compares it with that scholarship's configured category, and reports the excerpt and match status. Missing, conflicting, low-confidence, or unreadable category evidence stays undetermined or requires manual review. This is an OCR suggestion, not proof of certificate authenticity or official eligibility. The admin must inspect the original documents and still manually accept or reject each application.

Install [Ollama for Windows](https://ollama.com/download), then download the default model and start Ollama:

```powershell
ollama pull llama3.2:1b
```

Keep Ollama running and restart FastAPI. The health response at `http://localhost:8000/health` includes `ai_review.available`, the configured model, and any setup message. Both student and admin review APIs are unchanged: `POST /api/applications/{id}/ai-review` and `POST /api/admin/applications/{id}/ai-review`; each requires the matching signed-in role and accepts `{}`. For example, after signing in and saving the session cookie in `cookies.txt`:

```sh
curl -X POST http://localhost:3000/api/applications/1/ai-review \
  -H 'Content-Type: application/json' \
  -b cookies.txt -d '{}'
```

Students can also use **Check OCR text against requirements** in their application; admins use **Analyze OCR and prepare review list**. The report's document links download the original private files through the authenticated application route. An admin must inspect each original and manually upload any cleared document to the government website. There is no government portal connection or automated upload in this project.

The model uses Ollama's [chat API](https://docs.ollama.com/api/chat) with [structured outputs](https://docs.ollama.com/capabilities/structured-outputs); FastAPI validates the returned fields before using them. The model's result is advisory and must be checked against the original document.

The scholarship catalogue APIs are `GET /api/scholarships` (active scholarships visible to the signed-in student after CGPA filtering; all scholarships for admins), `POST /api/admin/scholarships` (create a scholarship with documents and optional screening rules), `PATCH /api/admin/scholarships/{id}/requirements` (edit those settings on an existing card), and `PATCH /api/admin/scholarships/{id}/status` (publish or hide a card). `GET /api/students/me/academic-profile` returns the signed-in student's own CGPA record. Admins can view records at `GET /api/admin/students/academic-profiles` and set them at `PUT /api/admin/students/{student_id}/academic-profile`. Only admins can change student CGPA records or manage scholarship cards.

The workflow APIs are:

- `GET/POST /api/applications`, `GET/PUT /api/applications/{id}`, and `POST /api/applications/{id}/submit` for a student's own drafts and submissions.
- `POST /api/applications/{id}/documents`, `GET /api/applications/{id}/documents`, and `GET /api/applications/{id}/documents/{documentId}` for authorized uploads, metadata, and downloads.
- `POST /api/applications/{id}/ai-review` for an owned student's preliminary OCR review, and `POST /api/admin/applications/{id}/ai-review` for the administrator's review list. The latest report is included in each authorized application detail response and is invalidated after application edits, new uploads, or OCR reruns so it can be regenerated from current data.
- `GET /api/admin/applications?page=1&per_page=20&status=Submitted`, `GET /api/admin/applications/{id}`, and `PATCH /api/admin/applications/{id}/review` for admin review.

The upload form accepts PDF, JPEG, and PNG files only. Express checks the extension, declared MIME type, and file signature before forwarding; FastAPI checks the signature again. Files are stored outside the frontend in the private `ai-service/private-uploads/` directory by default. `MAX_UPLOAD_BYTES` (default 10 MiB) can be set in both FastAPI and Express; set it consistently in both services. `MAX_FILES_PER_APPLICATION` (default 8) is enforced by FastAPI. `UPLOAD_DIR` can change the FastAPI private storage directory. Document metadata and application data are stored in the configured SQLite database.

### Local OCR for uploaded documents

The FastAPI service uses Tesseract locally, through `pytesseract`, with Pillow for images and PyMuPDF for PDFs. Uploaded images are OCR processed; PDFs first use embedded text when present and OCR scanned pages. Processing is limited to 10 PDF pages and 45 seconds per document by default. OCR text and status are saved with the document. Students can see the OCR status for their files; only admins can view extracted text in the application review screen. Admins can retry OCR on existing files with **Run OCR again**. OCR may misread personal details and must be checked against the original; it does not verify authenticity or decide eligibility.

Install the Tesseract engine on Windows, then reinstall the Python requirements and restart FastAPI:

```powershell
winget install --id UB-Mannheim.TesseractOCR --exact
..venv\Scripts\python.exe -m pip install -r requirements.txt
..venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

The Windows installer and other platform instructions are linked from the [Tesseract installation documentation](https://github.com/tesseract-ocr/tessdoc/blob/main/Installation.md). If Tesseract is installed outside PATH, set `TESSERACT_CMD` to the full executable path before starting FastAPI. Confirm OCR readiness at `http://localhost:8000/health`: its `ocr.available` value should be `true`. For languages besides English, install the matching Tesseract trained data and set `OCR_LANGUAGE`.

Cookie-based state-changing browser requests use `SameSite=Lax` and an Express `Origin` allowlist (`ALLOWED_ORIGINS`, comma-separated). The backend rate limits sign-in, registration, and writes in each process. Local development uses Vite on port 5174; Express allows both `localhost` and `127.0.0.1` on that port by default.

To test the project, run `npm test` from `backend`, `npm run build` from `frontend`, and `python -m unittest discover -s tests` from `ai-service` with its virtual environment active. Install the test client first with `pip install -r requirements-dev.txt`. Python workflow tests use temporary SQLite databases and synthetic in-memory PDF bytes; they do not open or reset the configured project database and do not use real student records or documents.

The frontend reads the backend base URL from `frontend/.env` (`VITE_API_BASE_URL`). After changing this value, restart the Vite dev server. The frontend checks `/api/health` and displays the connection status. Express allows `http://localhost:5174` and `http://127.0.0.1:5174` by default; set `ALLOWED_ORIGINS` if the frontend uses a different origin.

To verify the connection, start the backend and frontend in separate terminals using the commands above, open `http://127.0.0.1:5174`, and confirm the Backend API card says `Connected: ok`. You can also open `http://localhost:3000/api/health` directly to check the backend response.

## Start the Python service

Open another terminal in `ai-service`, create and activate a virtual environment, then install the requirements and run the app.

Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

macOS or Linux:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The Python service listens at `http://localhost:8000`; its health check is `http://localhost:8000/health` and its interactive API docs are at `http://localhost:8000/docs`.

To verify the Express-to-FastAPI connection, start FastAPI first, then start Express in another terminal. Open `http://localhost:3000/api/health`; a successful response includes the FastAPI service name and `status: "ok"`. If FastAPI is stopped or the URL is incorrect, Express returns HTTP 502 with a clear error message.

To try the demo renewal screening after both services are running, send a POST request:

```sh
curl -X POST http://localhost:3000/api/renewal/check \
  -H "Content-Type: application/json" \
  -d '{"previous_year_marks_percent": 68, "attendance_percent": 82, "annual_family_income": 250000, "document_types": ["marksheet", "attendance_report", "income_certificate"]}'
```

FastAPI validates the submitted values and returns the result for each demo requirement.
