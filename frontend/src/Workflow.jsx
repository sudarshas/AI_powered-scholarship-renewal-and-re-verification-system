import { useEffect, useState } from 'react';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const documentTypes = [
  ['marksheet', 'Marksheet'],
  ['attendance_report', 'Attendance report'],
  ['bonafide_certificate', 'Bonafide certificate'],
  ['income_certificate', 'Income certificate'],
  ['community_certificate', 'Community certificate'],
  ['other', 'Other supporting document'],
];
const reviewTransitions = {
  Submitted: ['Under Review', 'Documents Required', 'Rejected'],
  'Under Review': ['Documents Required', 'Verified', 'Rejected'],
  Resubmitted: ['Under Review', 'Documents Required', 'Verified', 'Rejected'],
  'Documents Required': ['Under Review', 'Rejected'],
};

async function apiRequest(path, options = {}) {
  const headers = { ...options.headers };
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    body,
    headers,
    credentials: 'include',
  });
  const result = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) {
    const detail = result?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const messages = [
        ...(detail.form_validation_errors || []).map((item) => `Form: ${item}`),
        ...(detail.missing_document_warnings || []).map((item) => `Missing document: ${item}`),
      ];
      throw new Error(messages.length ? messages.join('; ') : JSON.stringify(detail));
    }
    throw new Error(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : 'Request could not be completed');
  }
  return result;
}

function freshApplication(user, scheme, renewalYear) {
  return {
    scholarship_scheme: scheme,
    renewal_year: Number(renewalYear),
    student_information: {
      full_name: '',
      college_registration_number: '',
      email: user.email,
      mobile_number: '',
      college_name: '',
      department_or_course: '',
      current_year_of_study: '',
    },
    previous_scholarship: {
      previous_application_reference: '',
      previous_scholarship_academic_year: '',
    },
    academic_details: {
      previous_marks_or_cgpa: '',
      maximum_marks_or_grading_scale: '',
      percentage: '',
      arrears: '',
      current_semester_or_academic_year: '',
    },
    financial_details: { annual_family_income: '', income_certificate_details: '', other_scheme_specific_fields: '' },
    declaration: { confirmed: false },
  };
}

function applicationToForm(application, email) {
  const form = freshApplication({ email }, application.scholarship_scheme, application.renewal_year);
  return {
    ...form,
    ...application,
    student_information: { ...form.student_information, ...application.student_information, email },
    previous_scholarship: { ...form.previous_scholarship, ...application.previous_scholarship },
    academic_details: { ...form.academic_details, ...application.academic_details },
    financial_details: { ...form.financial_details, ...application.financial_details },
    declaration: { ...form.declaration, ...application.declaration },
  };
}

function applicationPayload(form) {
  const numeric = (value) => value === '' || value == null ? null : Number(value);
  return {
    ...form,
    academic_details: {
      ...form.academic_details,
      previous_marks_or_cgpa: numeric(form.academic_details.previous_marks_or_cgpa),
      maximum_marks_or_grading_scale: numeric(form.academic_details.maximum_marks_or_grading_scale),
      percentage: numeric(form.academic_details.percentage),
      arrears: numeric(form.academic_details.arrears),
    },
    financial_details: {
      ...form.financial_details,
      annual_family_income: numeric(form.financial_details.annual_family_income),
    },
  };
}

function printableDate(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toLocaleDateString() : 'Not submitted';
}

function renderSection(title, values) {
  return (
    <section className="details-section" key={title}>
      <h3>{title}</h3>
      <dl>
        {Object.entries(values || {}).map(([key, value]) => (
          <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{value === '' || value == null ? 'Not provided' : String(value)}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function StatusBadge({ status }) {
  return <span className={`status-badge status-${status?.toLowerCase().replaceAll(' ', '-')}`}>{status}</span>;
}

function AIReviewPanel({ report, admin = false }) {
  if (!report) return null;
  return <section className="ai-review-panel" aria-label="AI document review">
    <h3>Preliminary document review</h3>
    <p>{report.note}</p>
    {report.summary && <p>{report.summary}</p>}
    {admin && report.admin_suggestion && <aside className={`ai-admin-suggestion ai-admin-suggestion-${report.admin_suggestion.status}`} aria-live="polite">
      <h4>AI requirement suggestion: {report.admin_suggestion.title}</h4>
      {report.admin_suggestion.reasons?.length > 0 && <ul>{report.admin_suggestion.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      <p>Use this as a review aid only. Check the OCR against the original documents and make the accept or reject decision manually.</p>
    </aside>}
    <h4>Required documents</h4>
    {report.manual_upload_documents?.length
      ? <ul>{report.manual_upload_documents.map((item) => <li key={item.document_type}>{item.document_type.replaceAll('_', ' ')}: {item.status === 'missing' ? 'missing' : 'uploaded; verify manually'}</li>)}</ul>
      : <p>No required document list is configured for this scholarship.</p>}
    <h4>Configured scholarship checks</h4>
    {report.checks?.length ? <ul>{report.checks.map((check) => <li key={check.rule}>
      {check.rule.replaceAll('_', ' ')}: {check.status}{check.value != null ? ` (OCR value: ${check.value}; threshold: ${check.threshold})` : ''}
      {check.evidence ? <blockquote>“{check.evidence}”</blockquote> : null}
    </li>)}</ul> : <p>No eligibility checks are configured.</p>}
    {admin && report.documents?.length > 0 && <><h4>Files for manual review / government-site upload</h4><ul>{report.documents.map((document) => <li key={document.document_id}>
      <a href={`${apiBaseUrl}/api/applications/${report.application_id}/documents/${document.document_id}`} target="_blank" rel="noreferrer">{document.original_filename}</a>
      {' '}— uploaded as {document.uploaded_document_type.replaceAll('_', ' ')}, AI detected {document.detected_document_type.replaceAll('_', ' ')} ({document.document_type_matches ? 'type appears to match' : 'possible type mismatch'}); admin verification pending.
      {document.concerns?.length > 0 && <ul>{document.concerns.map((concern, index) => <li key={index}>{concern}</li>)}</ul>}
      {document.extracted_fields?.length > 0 && <ul>{document.extracted_fields.map((field, index) => <li key={index}>{field.field.replaceAll('_', ' ')}: {field.value} (confidence {field.confidence}%) — “{field.evidence}”</li>)}</ul>}
    </li>)}</ul></>}
    {admin && report.unreadable_documents?.length > 0 && <><h4>Files needing OCR or manual reading</h4><ul>{report.unreadable_documents.map((document) => <li key={document.document_id}><a href={`${apiBaseUrl}/api/applications/${report.application_id}/documents/${document.document_id}`} target="_blank" rel="noreferrer">{document.original_filename}</a> — {document.document_type.replaceAll('_', ' ')}, OCR status: {document.ocr_status}</li>)}</ul></>}
    <p><strong>No files are marked approved by AI.</strong> The admin must verify each original and upload any cleared files manually to the government website.</p>
  </section>;
}

function StudentNavigation({ page, onNavigate }) {
  return (
    <nav className="student-navigation" aria-label="Student pages">
      <button type="button" className={page === 'profile' ? 'active' : ''} aria-current={page === 'profile' ? 'page' : undefined} onClick={() => onNavigate('profile')}>My profile</button>
      <button type="button" className={page === 'scholarships' ? 'active' : ''} aria-current={page === 'scholarships' ? 'page' : undefined} onClick={() => onNavigate('scholarships')}>Scholarships</button>
    </nav>
  );
}

export function StudentDashboard({ user }) {
  const [applications, setApplications] = useState([]);
  const [scholarships, setScholarships] = useState([]);
  const [academicProfile, setAcademicProfile] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedScholarship, setSelectedScholarship] = useState(null);
  const [scholarshipApplications, setScholarshipApplications] = useState([]);
  const [scholarshipApplicationsLoading, setScholarshipApplicationsLoading] = useState(false);
  const [form, setForm] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [screen, setScreen] = useState('profile');
  const [step, setStep] = useState(0);
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);

  async function loadApplications() {
    const result = await apiRequest('/api/applications');
    setApplications(result.applications);
  }

  async function loadScholarships() {
    const result = await apiRequest('/api/scholarships');
    setScholarships(result.scholarships);
  }

  async function loadAcademicProfile() {
    const result = await apiRequest('/api/students/me/academic-profile');
    setAcademicProfile(result.academic_profile);
  }

  useEffect(() => {
    loadApplications().catch((requestError) => setError(requestError.message));
    loadScholarships().catch((requestError) => setError(requestError.message));
    loadAcademicProfile().catch((requestError) => setError(requestError.message));
  }, [user.id]);

  async function openScholarship(scholarship) {
    setError('');
    setSelectedScholarship(scholarship);
    setScholarshipApplications([]);
    setScholarshipApplicationsLoading(true);
    setScreen('scholarship-detail');
    try {
      const matching = applications.filter((application) => application.scholarship_scheme.toLowerCase() === scholarship.name.toLowerCase());
      const details = await Promise.all(matching.map((application) => apiRequest(`/api/applications/${application.id}`)));
      setScholarshipApplications(details);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setScholarshipApplicationsLoading(false);
    }
  }

  async function openApplication(id) {
    setError('');
    try {
      const result = await apiRequest(`/api/applications/${id}`);
      setSelected(result);
      setForm(applicationToForm(result, user.email));
      setIsEditing(['Draft', 'Documents Required'].includes(result.status));
      setScreen('application');
      setStep(0);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function startDraft(event, scholarship = selectedScholarship) {
    event.preventDefault();
    if (!scholarship) return;
    setBusy(true);
    setError('');
    try {
      const created = await apiRequest('/api/applications', {
        method: 'POST',
        body: { scholarship_scheme: scholarship.name, renewal_year: Number(newYear) },
      });
      const detail = await apiRequest(`/api/applications/${created.id}`);
      await loadApplications();
      setSelected(detail);
      setForm(applicationToForm(detail, user.email));
      setIsEditing(true);
      setStep(0);
      setScreen('application');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function updateField(section, key, value) {
    setForm((current) => ({ ...current, [section]: { ...current[section], [key]: value } }));
  }

  async function saveDraft({ quiet = false } = {}) {
    if (!form || !selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await apiRequest(`/api/applications/${selected.id}`, { method: 'PUT', body: applicationPayload(form) });
      const detail = await apiRequest(`/api/applications/${selected.id}`);
      setSelected(detail);
      setForm(applicationToForm(saved, user.email));
      await loadApplications();
      setNotice(quiet ? '' : 'Draft saved.');
      return true;
    } catch (requestError) {
      setError(requestError.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function moveStep(direction) {
    setError('');
    if (direction > 0) {
      const activeStep = document.querySelector('[data-form-step="active"]');
      const requiredFields = activeStep?.querySelectorAll('[required]') || [];
      for (const field of requiredFields) {
        if (!field.reportValidity()) return;
      }
      if (step === 0 && !(await saveDraft({ quiet: true }))) return;
    }
    setStep((current) => Math.max(0, Math.min(4, current + direction)));
  }

  async function submitApplication() {
    if (!form.declaration.confirmed) {
      setError('Confirm the declaration before submitting.');
      return;
    }
    const saved = await saveDraft();
    if (!saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/api/applications/${selected.id}/submit`, { method: 'POST' });
      const submittedDetail = await apiRequest(`/api/applications/${selected.id}`);
      setSelected(submittedDetail);
      setForm(applicationToForm(submittedDetail, user.email));
      setIsEditing(false);
      setNotice('Application submitted. Scheme-specific eligibility and supporting details may still require administrative verification.');
      await loadApplications();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument(documentType, file) {
    if (!file || !selected) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('document_type', documentType);
    setBusy(true);
    setIsUploading(true);
    setUploadPercent(0);
    setError('');
    setNotice('');
    try {
      const uploaded = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', `${apiBaseUrl}/api/applications/${selected.id}/documents`);
        request.withCredentials = true;
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) setUploadPercent(Math.round((event.loaded / event.total) * 100));
        };
        request.onload = () => {
          const result = JSON.parse(request.responseText || '{}');
          if (request.status >= 200 && request.status < 300) resolve(result);
          else reject(new Error(result.detail || 'Document upload failed'));
        };
        request.onerror = () => reject(new Error('Unable to reach the upload service'));
        request.send(formData);
      });
      const refreshed = await apiRequest(`/api/applications/${selected.id}`);
      refreshed.ai_review = null;
      setSelected(refreshed);
      setForm(applicationToForm(refreshed, user.email));
      await loadApplications();
      setNotice(uploaded.ocr_status === 'complete'
        ? 'Document uploaded and text extraction finished. Your college will verify the document and extracted text.'
        : uploaded.ocr_status === 'unavailable'
          ? 'Document uploaded. Text extraction is unavailable until the OCR service is configured.'
          : uploaded.ocr_status === 'no_text'
            ? 'Document uploaded, but no readable text was found.'
            : 'Document uploaded. Text extraction status: ' + uploaded.ocr_status + '.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsUploading(false);
      setBusy(false);
      setUploadPercent(0);
    }
  }

  async function runAIReview() {
    if (!selected) return;
    setAiReviewBusy(true);
    setError('');
    try {
      const report = await apiRequest(`/api/applications/${selected.id}/ai-review`, { method: 'POST' });
      setSelected((current) => ({ ...current, ai_review: report }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setAiReviewBusy(false);
    }
  }

  if (screen === 'scholarships') {
    const cgpaScholarships = scholarships.filter((scholarship) => scholarship.eligibility_rules?.minimum_cgpa != null);
    return (
      <>
      <StudentNavigation page="scholarships" onNavigate={setScreen} />
      <section className="card workflow-card">
        <p className="eyebrow">Scholarship catalogue</p><h2>Choose a scholarship</h2>
        <p>Select a scholarship to review its document requirements and your existing uploads.</p>
        {cgpaScholarships.length > 0 && <section className="cgpa-scholarship-section" aria-labelledby="cgpa-scholarships-heading">
          <h3 id="cgpa-scholarships-heading">CGPA scholarships matched to your profile</h3>
          <div className="scholarship-grid">{cgpaScholarships.map((scholarship) => <button className="scholarship-card" key={scholarship.id} onClick={() => openScholarship(scholarship)}>
            <span className="scholarship-card-icon" aria-hidden="true">✦</span><strong>{scholarship.name}</strong>
            <span>{scholarship.description || 'View details and required documents'}</span>
            <span className="cgpa-requirement">Minimum CGPA {scholarship.eligibility_rules.minimum_cgpa} / {scholarship.eligibility_rules.cgpa_scale}</span>
            {scholarship.eligibility_rules?.required_community_category && <span className="cgpa-requirement">Community category: {scholarship.eligibility_rules.required_community_category}</span>}
            <span className="scholarship-card-link">View scholarship <span aria-hidden="true">→</span></span>
          </button>)}</div>
        </section>}
        {scholarships.some((scholarship) => scholarship.eligibility_rules?.minimum_cgpa == null) && <h3>Other published scholarships</h3>}
        {scholarships.length === 0 ? <p className="empty-state">There are no active scholarships available for your profile right now. If your CGPA should qualify you, contact your college administrator to check your record.</p> : scholarships.some((scholarship) => scholarship.eligibility_rules?.minimum_cgpa == null) && (
          <div className="scholarship-grid">{scholarships.filter((scholarship) => scholarship.eligibility_rules?.minimum_cgpa == null).map((scholarship) => (
            <button className="scholarship-card" key={scholarship.id} onClick={() => openScholarship(scholarship)}>
              <span className="scholarship-card-icon" aria-hidden="true">✦</span>
              <strong>{scholarship.name}</strong>
              <span>{scholarship.description || 'View details and required documents'}</span>
              {scholarship.eligibility_rules?.minimum_cgpa != null && <span className="cgpa-requirement">Minimum CGPA {scholarship.eligibility_rules.minimum_cgpa} / {scholarship.eligibility_rules.cgpa_scale}</span>}
              {scholarship.eligibility_rules?.required_community_category && <span className="cgpa-requirement">Community category: {scholarship.eligibility_rules.required_community_category}</span>}
              <span className="scholarship-card-link">View scholarship <span aria-hidden="true">→</span></span>
            </button>
          ))}</div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      </>
    );
  }

  if (screen === 'scholarship-detail' && selectedScholarship) {
    const requiredDocuments = selectedScholarship.required_document_types || [];
    return (
      <section className="card workflow-card" aria-labelledby="scholarship-detail-heading">
        <StudentNavigation page="scholarships" onNavigate={setScreen} />
        <button className="text-button" onClick={() => setScreen('scholarships')}>Back to scholarships</button>
        <div className="application-heading"><div><p className="eyebrow">Scholarship details</p><h2 id="scholarship-detail-heading">{selectedScholarship.name}</h2></div><span className="status-badge status-verified">Open for applications</span></div>
        <p>{selectedScholarship.description || 'No additional scholarship information has been provided yet.'}</p>
        {selectedScholarship.eligibility_rules?.minimum_cgpa != null && <p className="cgpa-requirement">CGPA screening: at least {selectedScholarship.eligibility_rules.minimum_cgpa} out of {selectedScholarship.eligibility_rules.cgpa_scale}.</p>}
        {selectedScholarship.eligibility_rules?.required_community_category && <p className="cgpa-requirement">Community category required: {selectedScholarship.eligibility_rules.required_community_category}.</p>}
        <section className="scholarship-documents" aria-labelledby="required-documents-heading">
          <h3 id="required-documents-heading">Required documents</h3>
          {requiredDocuments.length ? <ul>{requiredDocuments.map((type) => <li key={type}>{documentTypes.find(([value]) => value === type)?.[1] || type}</li>)}</ul> : <p>No required document types have been specified.</p>}
        </section>
        <section className="scholarship-documents" aria-labelledby="uploaded-documents-heading">
          <h3 id="uploaded-documents-heading">Your uploaded documents</h3>
          {scholarshipApplicationsLoading ? <p>Checking your applications...</p> : scholarshipApplications.length === 0 ? <p>You have not started an application for this scholarship yet.</p> : scholarshipApplications.map((application) => (
            <div className="scholarship-upload-group" key={application.id}>
              <p><strong>{application.renewal_year}</strong> · {application.application_number} · <StatusBadge status={application.status} /></p>
              {application.documents?.length ? <ul className="document-list">{application.documents.map((document) => <li key={document.id}>{documentTypes.find(([value]) => value === document.document_type)?.[1] || document.document_type}: <a href={`${apiBaseUrl}/api/applications/${application.id}/documents/${document.id}`} target="_blank" rel="noreferrer">{document.original_filename}</a></li>)}</ul> : <p>No documents uploaded for this application yet.</p>}
            </div>
          ))}
        </section>
        <form className="start-scholarship-form" onSubmit={(event) => startDraft(event, selectedScholarship)}>
          <label>Renewal year<input type="number" min="2000" max="2200" value={newYear} onChange={(event) => setNewYear(event.target.value)} required /></label>
          <button disabled={busy}>{busy ? 'Creating...' : 'Start application'}</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    );
  }

  if (screen === 'application' && selected && form) {
    const steps = ['Student information', 'Previous scholarship', 'Academic information', 'Financial information', 'Review and declaration'];
    const field = (section, key, label, options = {}) => (
      <label key={`${section}.${key}`}>
        {label}
        <input
          type={options.type || 'text'}
          min={options.min}
          max={options.max}
          step={options.step}
          required={options.required !== false}
          readOnly={options.readOnly}
          value={form[section][key] ?? ''}
          onChange={(event) => updateField(section, key, event.target.value)}
        />
      </label>
    );
    const documents = selected.documents || [];
    const assessment = selected.assessment;

    return (
      <section className="card workflow-card" aria-labelledby="application-heading">
        <button className="text-button" onClick={() => { setScreen('profile'); setError(''); }}>Back to profile</button>
        <div className="application-heading">
          <div><p className="eyebrow">{selected.application_number}</p><h2 id="application-heading">{form.scholarship_scheme} · {form.renewal_year}</h2></div>
          <StatusBadge status={selected.status} />
        </div>
        <p>Created {printableDate(selected.created_at)} · Submitted {printableDate(selected.submitted_at)}</p>
        {selected.status === 'Verified' && <p className="success-box" role="status">Your application has been accepted and verified by the administrator.</p>}
        {selected.status === 'Rejected' && <p className="warning-box" role="status">The administrator has rejected this application. Review any feedback below or contact your college administrator.</p>}
        {selected.admin_feedback && <div className="feedback-box"><strong>Administrative feedback</strong><p>{selected.admin_feedback}</p></div>}
        {isEditing ? (
          <>
            <div className="step-indicator" aria-label="Application form progress">
              {steps.map((name, index) => <span className={index === step ? 'current' : index < step ? 'complete' : ''} key={name}>{index + 1}. {name}</span>)}
            </div>
            <form className="workflow-form" data-form-step="active" onSubmit={(event) => event.preventDefault()} noValidate>
              {step === 0 && <><p className="notice-box profile-autofill-note">Your personal and college details are saved to your profile when you continue. They will be filled in automatically on future applications; update them here if anything changes.</p><div className="form-grid">
                {field('student_information', 'full_name', 'Full name')}
                {field('student_information', 'college_registration_number', 'College registration number')}
                {field('student_information', 'email', 'Email', { type: 'email', readOnly: true })}
                {field('student_information', 'mobile_number', 'Mobile number', { type: 'tel' })}
                {field('student_information', 'college_name', 'College name')}
                {field('student_information', 'department_or_course', 'Department or course')}
                {field('student_information', 'current_year_of_study', 'Current year of study')}
              </div></>}
              {step === 1 && <div className="form-grid">
                <label>Scholarship scheme<input value={form.scholarship_scheme} readOnly /></label>
                <label>Renewal year<input value={form.renewal_year} readOnly /></label>
                {field('previous_scholarship', 'previous_application_reference', 'Previous beneficiary/application reference')}
                {field('previous_scholarship', 'previous_scholarship_academic_year', 'Previous scholarship academic year')}
              </div>}
              {step === 2 && <div className="form-grid">
                {field('academic_details', 'previous_marks_or_cgpa', 'Previous academic year marks or CGPA', { type: 'number', min: '0', step: 'any' })}
                {field('academic_details', 'maximum_marks_or_grading_scale', 'Maximum marks or grading scale', { type: 'number', min: '0.01', step: 'any' })}
                {field('academic_details', 'percentage', 'Percentage, if applicable', { type: 'number', min: '0', max: '100', step: 'any', required: false })}
                {field('academic_details', 'arrears', 'Number of arrears, if applicable', { type: 'number', min: '0', step: '1', required: false })}
                {field('academic_details', 'current_semester_or_academic_year', 'Current semester or academic year')}
              </div>}
              {step === 3 && <div className="form-grid">
                {field('financial_details', 'annual_family_income', 'Annual family income', { type: 'number', min: '0', step: 'any' })}
                {field('financial_details', 'income_certificate_details', 'Income certificate details', { required: false })}
                {field('financial_details', 'other_scheme_specific_fields', 'Other scheme-specific details, if applicable', { required: false })}
              </div>}
              {step === 4 && <div className="review-panel">
                <h3>Review application details</h3>
                {renderSection('Student information', form.student_information)}
                {renderSection('Previous scholarship', form.previous_scholarship)}
                {renderSection('Academic information', form.academic_details)}
                {renderSection('Financial information', form.financial_details)}
                {assessment?.eligibility_checks?.unconfigured && <p className="warning-box">Scheme-specific eligibility rules are not configured. Eligibility has not been determined.</p>}
                {assessment?.form_validation_errors?.length > 0 && <div className="warning-box"><strong>Form items to complete</strong><ul>{assessment.form_validation_errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                {assessment?.administrative_verification_items?.map((item) => <p className="notice-box" key={item}>{item}</p>)}
                {assessment?.missing_document_warnings?.length > 0 && <p className="warning-box">Missing documents requested for this application: {assessment.missing_document_warnings.join(', ').replaceAll('_', ' ')}.</p>}
                <h3>Supporting documents</h3>
                <p>Upload PDF, JPEG, or PNG documents. Files are stored privately, and the server enforces its configured size limit.</p>
                <div className="upload-list">
                  {documentTypes.map(([type, label]) => (
                    <label key={type} className="upload-row">{label}
                      <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; uploadDocument(type, file); }} />
                    </label>
                  ))}
                </div>
                {isUploading && <div className="upload-progress" role="status"><span>Uploading document... {uploadPercent}%</span><progress value={uploadPercent} max="100">{uploadPercent}%</progress></div>}
                <ul className="document-list">
                  {documents.map((document) => <li key={document.id}>{documentTypes.find(([type]) => type === document.document_type)?.[1] || document.document_type}: <a href={`${apiBaseUrl}/api/applications/${selected.id}/documents/${document.id}`} target="_blank" rel="noreferrer">{document.original_filename}</a> ({Math.ceil(document.size_bytes / 1024)} KB)</li>)}
                </ul>
                <button type="button" className="secondary-action" onClick={runAIReview} disabled={aiReviewBusy || busy}>{aiReviewBusy ? 'Reviewing OCR text...' : 'Check OCR text against requirements'}</button>
                {selected.ai_review && <AIReviewPanel report={selected.ai_review} />}
                <label className="declaration"><input type="checkbox" checked={form.declaration.confirmed === true} onChange={(event) => updateField('declaration', 'confirmed', event.target.checked)} />I confirm that the information provided is accurate to the best of my knowledge.</label>
              </div>}
            </form>
            {error && <p className="form-error" role="alert">{error}</p>}
            {notice && <p className="success-box" role="status">{notice}</p>}
            <div className="workflow-actions">
              <button type="button" className="secondary-action" onClick={saveDraft} disabled={busy}>{busy ? 'Saving...' : 'Save draft'}</button>
              <div>
                {step > 0 && <button type="button" className="secondary-action" onClick={() => moveStep(-1)}>Previous</button>}
                {step < 4
                  ? <button type="button" onClick={() => moveStep(1)}>Continue</button>
                  : <button type="button" onClick={submitApplication} disabled={busy}>{busy ? 'Submitting...' : 'Submit application'}</button>}
              </div>
            </div>
          </>
        ) : (
          <>
            {renderSection('Student information', selected.student_information)}
            {renderSection('Previous scholarship', selected.previous_scholarship)}
            {renderSection('Academic information', selected.academic_details)}
            {renderSection('Financial information', selected.financial_details)}
            {selected.assessment?.missing_document_warnings?.length > 0 && <p className="warning-box">Required or requested documents missing: {selected.assessment.missing_document_warnings.map((type) => type.replaceAll('_', ' ')).join(', ')}.</p>}
            {documents.length > 0 && <><h3>Supporting documents</h3><ul className="document-list">{documents.map((document) => <li key={document.id}><a href={`${apiBaseUrl}/api/applications/${selected.id}/documents/${document.id}`} target="_blank" rel="noreferrer">{document.original_filename}</a></li>)}</ul></>}
            <button type="button" className="secondary-action" onClick={runAIReview} disabled={aiReviewBusy}>{aiReviewBusy ? 'Reviewing OCR text...' : 'Check OCR text against requirements'}</button>
            {selected.ai_review && <AIReviewPanel report={selected.ai_review} />}
            {selected.missing_document_types?.length > 0 && <p className="warning-box">Documents requested: {selected.missing_document_types.join(', ').replaceAll('_', ' ')}.</p>}
            {selected.admin_feedback && <div className="feedback-box"><strong>Administrative feedback</strong><p>{selected.admin_feedback}</p></div>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {notice && <p className="success-box" role="status">{notice}</p>}
          </>
        )}
      </section>
    );
  }

  const registeredScholarships = new Set(applications.map((application) => application.scholarship_scheme.toLowerCase())).size;
  return (
    <>
      <StudentNavigation page="profile" onNavigate={setScreen} />
      <section className="card student-profile" aria-label="Student profile">
        <div><p className="eyebrow">Your student profile</p><h2>{user.email}</h2><p>Student account</p></div>
        <div className="profile-stat"><strong>{applications.length}</strong><span>Applications</span></div>
        <div className="profile-stat"><strong>{registeredScholarships}</strong><span>Scholarships registered</span></div>
      </section>

      <section className="card workflow-card" aria-labelledby="student-cgpa-heading">
        <p className="eyebrow">Scholarship matching</p><h2 id="student-cgpa-heading">Your CGPA profile</h2>
        <p>Your college manages this record. Scholarships with a CGPA cutoff appear only when your stored CGPA meets the cutoff on the same grading scale.</p>
        {academicProfile ? <p className="success-box">College record: {academicProfile.cgpa} / {academicProfile.cgpa_scale}</p> : <p className="notice-box">Your CGPA record has not been added yet. Contact your college administrator if a CGPA scholarship should be available to you.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="success-box" role="status">{notice}</p>}
      </section>

      <section className="card workflow-card" aria-labelledby="student-dashboard-heading">
        <div className="dashboard-heading"><div><p className="eyebrow">Your progress</p><h2 id="student-dashboard-heading">My applications</h2></div><button onClick={() => { setScreen('scholarships'); setError(''); }}>View scholarships</button></div>
        {applications.length === 0 ? <p className="empty-state">You have no renewal applications yet. Browse scholarships to get started.</p> : (
          <div className="application-table-wrap"><table><thead><tr><th>Application number</th><th>Scholarship</th><th>Renewal year</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>
            {applications.map((application) => <tr key={application.id}>
              <td>{application.application_number}</td><td>{application.scholarship_scheme}</td><td>{application.renewal_year}</td><td>{printableDate(application.submitted_at)}</td><td><StatusBadge status={application.status} /></td>
              <td><button className="text-button" onClick={() => openApplication(application.id)}>{['Draft', 'Documents Required'].includes(application.status) ? 'Continue editing' : 'View details'}</button></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </>
  );
}

const demoScholarshipNames = [
  'Merit Renewal Scholarship',
  'STEM Student Support Grant',
  'Community Learning Award',
  'First Generation Student Scholarship',
  'Rural Education Continuity Grant',
];
const demoStudentNames = [
  ['Aarav Sharma', 'Diya Patel'],
  ['Ishaan Kumar', 'Ananya Singh'],
  ['Vivaan Das', 'Meera Nair'],
  ['Arjun Rao', 'Sara Khan'],
  ['Rohan Iyer', 'Kavya Joshi'],
];
const demoScholarships = demoScholarshipNames.map((name, index) => ({
  id: `demo-scholarship-${index + 1}`,
  name,
  description: [
    'Sample award for students maintaining strong academic progress.',
    'Sample assistance for students enrolled in science and technology courses.',
    'Sample support for students continuing their studies in the community.',
    'Sample scholarship for students who are first in their family to attend college.',
    'Sample support for students continuing higher education from rural areas.',
  ][index],
  requiredDocuments: ['Marksheet', 'Attendance report', 'Bonafide certificate'],
  students: demoStudentNames[index].map((fullName, studentIndex) => ({
    id: `demo-student-${index + 1}-${studentIndex + 1}`,
    fullName,
    email: `student${index * 2 + studentIndex + 1}@example.test`,
    rollNumber: `DEMO-${String(index * 2 + studentIndex + 1).padStart(3, '0')}`,
    course: ['Computer Science', 'Commerce', 'Mathematics', 'Biotechnology', 'Economics'][index],
    year: studentIndex + 2,
    marks: 72 + index * 3 + studentIndex * 2,
    attendance: 80 + index + studentIndex * 2,
    familyIncome: 180000 + index * 15000,
    previousAward: 'Sample renewal award · 2025',
    documents: [
      { type: 'Marksheet', filename: `DEMO_${index + 1}_${studentIndex + 1}_Marksheet.pdf` },
      { type: 'Attendance report', filename: `DEMO_${index + 1}_${studentIndex + 1}_Attendance.pdf` },
      { type: 'Bonafide certificate', filename: `DEMO_${index + 1}_${studentIndex + 1}_Bonafide.pdf` },
    ],
  })),
}));

function DemoScholarshipOverview() {
  const [selectedScholarship, setSelectedScholarship] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [decisions, setDecisions] = useState({});
  const activeScholarship = demoScholarships.find((scholarship) => scholarship.id === selectedScholarship);
  const activeStudent = activeScholarship?.students.find((student) => student.id === selectedStudent);

  return <section className="demo-dashboard" aria-labelledby="demo-dashboard-heading">
    <div className="dashboard-heading"><div><p className="eyebrow">Sample data · demo only</p><h2 id="demo-dashboard-heading">Scholarship overview</h2></div><p>Click a registered-student count, then a name, to view the sample application.</p></div>
    <div className="demo-scholarship-grid">{demoScholarships.map((scholarship) => <button type="button" className={`demo-scholarship-card ${selectedScholarship === scholarship.id ? 'selected' : ''}`} key={scholarship.id} onClick={() => { setSelectedScholarship(scholarship.id); setSelectedStudent(null); }}>
      <span className="demo-card-icon" aria-hidden="true">✦</span><strong>{scholarship.name}</strong><span>{scholarship.description}</span>
      <span className="demo-student-count">{scholarship.students.length}<small> registered students</small></span>
    </button>)}</div>
    {activeScholarship && <section className="demo-roster" aria-label={`${activeScholarship.name} sample students`}>
      <div className="dashboard-heading"><div><p className="eyebrow">Sample scholarship</p><h3>{activeScholarship.name}</h3></div><span className="status-badge">{activeScholarship.students.length} students</span></div>
      <p>{activeScholarship.description}</p>
      <h4>Registered students</h4>
      <div className="demo-student-list">{activeScholarship.students.map((student) => <button type="button" className={selectedStudent === student.id ? 'selected' : ''} key={student.id} onClick={() => setSelectedStudent(student.id)}>
        <span><strong>{student.fullName}</strong><small>{student.email} · Roll no. {student.rollNumber}</small></span><StatusBadge status={decisions[student.id] || 'Submitted'} /><span aria-hidden="true">›</span>
      </button>)}</div>
      {activeStudent && <article className="demo-student-detail">
        <div className="application-heading"><div><p className="eyebrow">Demo application</p><h3>{activeStudent.fullName}</h3></div><StatusBadge status={decisions[activeStudent.id] || 'Submitted'} /></div>
        <div className="demo-detail-grid"><p><strong>Email</strong>{activeStudent.email}</p><p><strong>Roll number</strong>{activeStudent.rollNumber}</p><p><strong>Course</strong>{activeStudent.course}</p><p><strong>Year of study</strong>{activeStudent.year}</p><p><strong>Previous award</strong>{activeStudent.previousAward}</p><p><strong>Previous-year marks</strong>{activeStudent.marks}%</p><p><strong>Attendance</strong>{activeStudent.attendance}%</p><p><strong>Annual family income</strong>₹{activeStudent.familyIncome.toLocaleString('en-IN')}</p></div>
        <h4>Sample documents</h4><ul>{activeStudent.documents.map((document) => <li key={document.filename}>{document.type}: {document.filename} <span className="demo-file-note">(fictional placeholder; not an uploaded file)</span></li>)}</ul>
        <p className="notice-box">This is fictional sample data for dashboard demonstration. Decisions here do not affect real applications.</p>
        <div className="demo-decision-actions"><button type="button" onClick={() => setDecisions((current) => ({ ...current, [activeStudent.id]: 'Verified' }))}>Accept sample application</button><button type="button" className="secondary-action" onClick={() => setDecisions((current) => ({ ...current, [activeStudent.id]: 'Rejected' }))}>Reject sample application</button></div>
      </article>}
    </section>}
  </section>;
}

export function AdminDashboard() {
  const [applications, setApplications] = useState([]);
  const [scholarships, setScholarships] = useState([]);
  const [scholarshipName, setScholarshipName] = useState('');
  const [scholarshipDescription, setScholarshipDescription] = useState('');
  const [requiredDocumentTypes, setRequiredDocumentTypes] = useState([]);
  const [eligibilityRules, setEligibilityRules] = useState({ minimum_percentage: '', minimum_cgpa: '', cgpa_scale: '10', minimum_attendance_percent: '', maximum_arrears: '', maximum_annual_family_income: '', required_community_category: '' });
  const [scholarshipBusy, setScholarshipBusy] = useState(false);
  const [requirementsBusyId, setRequirementsBusyId] = useState(null);
  const [studentEmail, setStudentEmail] = useState('');
  const [studentRollNumber, setStudentRollNumber] = useState('');
  const [studentBusy, setStudentBusy] = useState(false);
  const [cgpaStudents, setCgpaStudents] = useState([]);
  const [cgpaStudentsLoading, setCgpaStudentsLoading] = useState(false);
  const [cgpaDrafts, setCgpaDrafts] = useState({});
  const [cgpaSavingId, setCgpaSavingId] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [reviewStatus, setReviewStatus] = useState('Under Review');
  const [feedback, setFeedback] = useState('');
  const [missing, setMissing] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ocrBusyId, setOcrBusyId] = useState(null);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  const [adminScreen, setAdminScreen] = useState('scholarships');
  const [activeScholarship, setActiveScholarship] = useState(null);
  const [scholarshipStudents, setScholarshipStudents] = useState([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [selectedDemoStudent, setSelectedDemoStudent] = useState(null);
  const [demoDecisions, setDemoDecisions] = useState({});

  async function loadApplications() {
    const query = new URLSearchParams({ page: String(page), per_page: '10' });
    if (statusFilter) query.set('status', statusFilter);
    const result = await apiRequest(`/api/admin/applications?${query}`);
    setApplications(result.applications);
    setTotal(result.total);
  }

  async function loadScholarships() {
    const result = await apiRequest('/api/scholarships');
    setScholarships(result.scholarships);
  }

  useEffect(() => {
    loadApplications().catch((requestError) => setError(requestError.message));
    loadScholarships().catch((requestError) => setError(requestError.message));
  }, [page, statusFilter]);

  useEffect(() => {
    loadCgpaStudents().catch((requestError) => setError(requestError.message));
  }, []);

  async function createScholarship(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    setScholarshipBusy(true);
    try {
      const created = await apiRequest('/api/admin/scholarships', {
        method: 'POST',
        body: {
          name: scholarshipName,
          description: scholarshipDescription,
          required_document_types: eligibilityRules.required_community_category.trim()
            ? [...new Set([...requiredDocumentTypes, 'community_certificate'])]
            : requiredDocumentTypes,
          eligibility_rules: Object.fromEntries(Object.entries(eligibilityRules).filter(([key, value]) => (key === 'required_community_category' ? value.trim() !== '' : value !== '') && !(key === 'cgpa_scale' && eligibilityRules.minimum_cgpa === '')).map(([key, value]) => [key, key === 'required_community_category' ? value.trim() : Number(value)])),
        },
      });
      setScholarshipName('');
      setScholarshipDescription('');
      setRequiredDocumentTypes([]);
      setEligibilityRules({ minimum_percentage: '', minimum_cgpa: '', cgpa_scale: '10', minimum_attendance_percent: '', maximum_arrears: '', maximum_annual_family_income: '', required_community_category: '' });
      await loadScholarships();
      setActiveScholarship(created);
      setScholarshipStudents([]);
      setSelectedDemoStudent(null);
      setAdminScreen('students');
      setNotice('Scholarship created. There are no registered students yet.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setScholarshipBusy(false);
    }
  }

  async function openScholarshipStudents(scholarship) {
    setError('');
    setNotice('');
    setSelected(null);
    setActiveScholarship(scholarship);
    setSelectedDemoStudent(null);
    setAdminScreen('students');
    setStudentsLoading(true);
    try {
      const result = await apiRequest(`/api/admin/scholarships/${scholarship.id}/applications`);
      setScholarshipStudents(result.registered_students);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStudentsLoading(false);
    }
  }

  function openDemoScholarship(scholarship) {
    setError('');
    setNotice('');
    setSelected(null);
    setActiveScholarship({ ...scholarship, is_demo: true });
    setSelectedDemoStudent(null);
    setScholarshipStudents([]);
    setStudentsLoading(false);
    setAdminScreen('students');
  }

  async function provisionStudent(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    setStudentBusy(true);
    try {
      const result = await apiRequest('/api/admin/students', {
        method: 'POST',
        body: { email: studentEmail, roll_number: studentRollNumber },
      });
      setNotice(`Student account created for ${result.student.email}. Their roll number is the temporary password; share it privately.`);
      setStudentEmail('');
      setStudentRollNumber('');
      await loadCgpaStudents();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStudentBusy(false);
    }
  }

  async function loadCgpaStudents() {
    setCgpaStudentsLoading(true);
    try {
      const result = await apiRequest('/api/admin/students/academic-profiles');
      setCgpaStudents(result.students);
      setCgpaDrafts(Object.fromEntries(result.students.map((student) => [student.id, {
        cgpa: student.cgpa == null ? '' : String(student.cgpa),
        cgpa_scale: student.cgpa_scale == null ? '10' : String(student.cgpa_scale),
      }])));
    } finally {
      setCgpaStudentsLoading(false);
    }
  }

  async function saveStudentCgpa(event, studentId) {
    event.preventDefault();
    setError('');
    setNotice('');
    setCgpaSavingId(studentId);
    try {
      const draft = cgpaDrafts[studentId];
      await apiRequest(`/api/admin/students/${studentId}/academic-profile`, {
        method: 'PUT', body: { cgpa: Number(draft.cgpa), cgpa_scale: Number(draft.cgpa_scale) },
      });
      await loadCgpaStudents();
      await loadScholarships();
      setNotice('College CGPA record saved. Student scholarship visibility now reflects this value.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setCgpaSavingId(null);
    }
  }

  async function toggleScholarship(scholarship) {
    setError('');
    setNotice('');
    try {
      await apiRequest(`/api/admin/scholarships/${scholarship.id}/status`, {
        method: 'PATCH',
        body: { is_active: !scholarship.is_active },
      });
      await loadScholarships();
      setNotice(scholarship.is_active ? 'Scholarship hidden from students.' : 'Scholarship published to students.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function saveScholarshipRequirements(event, scholarshipId) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const eligibility_rules = {};
    for (const key of ['minimum_percentage', 'minimum_attendance_percent', 'maximum_arrears', 'maximum_annual_family_income']) {
      const value = formData.get(key);
      if (value !== '') eligibility_rules[key] = Number(value);
    }
    const minimumCgpa = formData.get('minimum_cgpa');
    if (minimumCgpa !== '') {
      eligibility_rules.minimum_cgpa = Number(minimumCgpa);
      eligibility_rules.cgpa_scale = Number(formData.get('cgpa_scale'));
    }
    const requiredCommunityCategory = String(formData.get('required_community_category') || '').trim();
    if (requiredCommunityCategory) eligibility_rules.required_community_category = requiredCommunityCategory;
    const requiredDocumentTypes = formData.getAll('required_document_types');
    if (requiredCommunityCategory && !requiredDocumentTypes.includes('community_certificate')) {
      requiredDocumentTypes.push('community_certificate');
    }
    setError('');
    setNotice('');
    setRequirementsBusyId(scholarshipId);
    try {
      await apiRequest(`/api/admin/scholarships/${scholarshipId}/requirements`, {
        method: 'PATCH',
        body: { required_document_types: requiredDocumentTypes, eligibility_rules },
      });
      await loadScholarships();
      setNotice('Scholarship requirements and screening rules updated.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRequirementsBusyId(null);
    }
  }

  function toggleRequiredDocument(type) {
    setRequiredDocumentTypes((current) => current.includes(type)
      ? current.filter((item) => item !== type)
      : [...current, type]);
  }

  async function openApplication(id) {
    setError('');
    try {
      const result = await apiRequest(`/api/admin/applications/${id}`);
      setSelected(result);
      setSelectedDemoStudent(null);
      setFeedback(result.admin_feedback || '');
      setMissing(result.missing_document_types || []);
      const available = reviewTransitions[result.status] || [];
      setReviewStatus(available[0] || 'Under Review');
      setAdminScreen('student');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function runDocumentOcr(document) {
    if (!selected) return;
    setError('');
    setNotice('');
    setOcrBusyId(document.id);
    try {
      const result = await apiRequest('/api/admin/applications/' + selected.id + '/documents/' + document.id + '/ocr', { method: 'POST' });
      setSelected((current) => ({
        ...current,
        ai_review: null,
        documents: current.documents.map((item) => item.id === document.id ? result : item),
      }));
      setNotice(result.ocr_status === 'complete'
        ? 'OCR finished for ' + document.original_filename + '. Please verify the extracted text manually.'
        : result.ocr_error || 'OCR finished with status: ' + result.ocr_status + '.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setOcrBusyId(null);
    }
  }

  async function runApplicationAIReview() {
    if (!selected) return;
    setError('');
    setAiReviewBusy(true);
    try {
      const report = await apiRequest(`/api/admin/applications/${selected.id}/ai-review`, { method: 'POST' });
      setSelected((current) => ({ ...current, ai_review: report }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setAiReviewBusy(false);
    }
  }

  async function saveReview(event) {
    event.preventDefault();
    if (!selected) return;
    setError('');
    setNotice('');
    try {
      const result = await apiRequest(`/api/admin/applications/${selected.id}/review`, {
        method: 'PATCH',
        body: { status: reviewStatus, feedback, missing_document_types: missing },
      });
      setSelected((current) => ({ ...current, ...result }));
      setNotice('Review update saved.');
      await loadApplications();
      await openApplication(selected.id);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function decideApplication(status) {
    if (!selected) return;
    setError('');
    setNotice('');
    try {
      await apiRequest(`/api/admin/applications/${selected.id}/review`, {
        method: 'PATCH',
        body: { status, feedback, missing_document_types: [] },
      });
      setNotice(status === 'Verified' ? 'Application accepted and marked verified.' : 'Application rejected.');
      await loadApplications();
      await openApplication(selected.id);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function toggleMissing(type) {
    setMissing((selectedTypes) => selectedTypes.includes(type)
      ? selectedTypes.filter((item) => item !== type)
      : [...selectedTypes, type]);
  }

  return (
    <section className="card workflow-card">
      <div className="dashboard-heading"><div><p className="eyebrow">Administrator workspace</p><h2>{adminScreen === 'scholarships' ? 'Scholarships' : adminScreen === 'students' ? 'Registered students' : 'Student application'}</h2></div>
        {adminScreen !== 'scholarships' && <button type="button" className="secondary-action" onClick={() => { setError(''); setNotice(''); if (adminScreen === 'student' && activeScholarship?.is_demo) { setSelectedDemoStudent(null); setAdminScreen('students'); } else if (adminScreen === 'student' && activeScholarship) { setSelected(null); openScholarshipStudents(activeScholarship); } else { setSelected(null); setSelectedDemoStudent(null); setAdminScreen('scholarships'); } }}>← Back to {adminScreen === 'student' ? 'students' : 'scholarships'}</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="success-box" role="status">{notice}</p>}
      {adminScreen === 'scholarships' && <>
      <details className="scholarship-admin">
        <summary><span>Student accounts</span><span className="summary-hint">Create a college-issued student login</span></summary>
        <div className="scholarship-admin-content">
          <p>Enter the student’s college email and roll number. The roll number is their temporary password, and they must change it at first sign-in.</p>
          <form className="scholarship-admin-form" onSubmit={provisionStudent}>
            <label>College email<input type="email" autoComplete="off" value={studentEmail} onChange={(event) => setStudentEmail(event.target.value)} required /></label>
            <label>Roll number<input type="text" autoComplete="off" value={studentRollNumber} onChange={(event) => setStudentRollNumber(event.target.value)} maxLength="128" required /></label>
            <button type="submit" disabled={studentBusy}>{studentBusy ? 'Creating account...' : 'Create student account'}</button>
          </form>
        </div>
      </details>
      <details className="scholarship-admin">
        <summary><span>College CGPA records</span><span className="summary-hint">Set the academic record used for scholarship matching</span></summary>
        <div className="scholarship-admin-content">
          <p>Enter each student's official CGPA and grading scale. Students cannot edit this record. Matching scholarships are shown only when the saved value meets the published cutoff.</p>
          {cgpaStudentsLoading ? <p>Loading student records...</p> : cgpaStudents.length === 0 ? <p className="empty-state">Create a student account first; it will appear here.</p> : <div className="cgpa-student-list">
            {cgpaStudents.map((student) => <form className="cgpa-student-row" key={student.id} onSubmit={(event) => saveStudentCgpa(event, student.id)}>
              <div><strong>{student.email}</strong><span>{student.cgpa == null ? 'No CGPA record yet' : `Stored CGPA: ${student.cgpa} / ${student.cgpa_scale}`}</span></div>
              <label>CGPA<input type="number" min="0" max={cgpaDrafts[student.id]?.cgpa_scale || 100} step="any" value={cgpaDrafts[student.id]?.cgpa ?? ''} onChange={(event) => setCgpaDrafts((current) => ({ ...current, [student.id]: { ...current[student.id], cgpa: event.target.value } }))} required /></label>
              <label>Scale maximum<input type="number" min="0.01" max="100" step="any" value={cgpaDrafts[student.id]?.cgpa_scale ?? '10'} onChange={(event) => setCgpaDrafts((current) => ({ ...current, [student.id]: { ...current[student.id], cgpa_scale: event.target.value } }))} required /></label>
              <button type="submit" disabled={cgpaSavingId === student.id}>{cgpaSavingId === student.id ? 'Saving...' : 'Save CGPA'}</button>
            </form>)}
          </div>}
        </div>
      </details>
      <details className="scholarship-admin" open>
        <summary><span>Scholarship catalogue</span><span className="summary-hint">Create scholarships for students to browse</span></summary>
        <div className="scholarship-admin-content">
          <form className="scholarship-admin-form" onSubmit={createScholarship}>
            <label>Scholarship name<input value={scholarshipName} onChange={(event) => setScholarshipName(event.target.value)} maxLength="160" required /></label>
            <label>Student-facing description<textarea rows="3" maxLength="2000" value={scholarshipDescription} onChange={(event) => setScholarshipDescription(event.target.value)} placeholder="Briefly describe who this scholarship is for." /></label>
            <fieldset><legend>Required documents</legend>{documentTypes.map(([type, label]) => <label key={type}><input type="checkbox" checked={requiredDocumentTypes.includes(type) || (type === 'community_certificate' && Boolean(eligibilityRules.required_community_category.trim()))} onChange={() => toggleRequiredDocument(type)} />{label}</label>)}</fieldset>
            <fieldset><legend>Optional numeric screening rules</legend>
              <label>Minimum marks (%)<input type="number" min="0" max="100" step="any" value={eligibilityRules.minimum_percentage} onChange={(event) => setEligibilityRules((current) => ({ ...current, minimum_percentage: event.target.value }))} /></label>
              <label>Minimum attendance (%)<input type="number" min="0" max="100" step="any" value={eligibilityRules.minimum_attendance_percent} onChange={(event) => setEligibilityRules((current) => ({ ...current, minimum_attendance_percent: event.target.value }))} /></label>
              <label>Maximum arrears<input type="number" min="0" step="1" value={eligibilityRules.maximum_arrears} onChange={(event) => setEligibilityRules((current) => ({ ...current, maximum_arrears: event.target.value }))} /></label>
              <label>Maximum annual family income (₹)<input type="number" min="0" step="any" value={eligibilityRules.maximum_annual_family_income} onChange={(event) => setEligibilityRules((current) => ({ ...current, maximum_annual_family_income: event.target.value }))} /></label>
              <p>These rules are used for preliminary OCR comparison. Verify them and each original document manually.</p>
            </fieldset>
            <fieldset className="cgpa-rules"><legend>Community eligibility</legend>
              <label>Required community category<input type="text" maxLength="80" value={eligibilityRules.required_community_category} onChange={(event) => setEligibilityRules((current) => ({ ...current, required_community_category: event.target.value }))} placeholder="For example: BC" /></label>
              <p>When set, a community certificate is automatically required. AI will compare the printed category with this requirement and show its OCR evidence for manual review.</p>
            </fieldset>
            <fieldset className="cgpa-rules"><legend>CGPA eligibility</legend>
              <label>Minimum CGPA<input type="number" min="0" max={eligibilityRules.cgpa_scale || 100} step="any" value={eligibilityRules.minimum_cgpa} onChange={(event) => setEligibilityRules((current) => ({ ...current, minimum_cgpa: event.target.value }))} /></label>
              <label>CGPA scale maximum<input type="number" min="0.01" max="100" step="any" value={eligibilityRules.cgpa_scale} onChange={(event) => setEligibilityRules((current) => ({ ...current, cgpa_scale: event.target.value }))} /></label>
              <p>Only students whose college-managed CGPA record meets this cutoff on the same grading scale will see this scholarship.</p>
            </fieldset>
            <button type="submit" disabled={scholarshipBusy}>{scholarshipBusy ? 'Publishing...' : 'Publish scholarship'}</button>
          </form>
          {scholarships.length ? <div className="admin-scholarship-list"><h3>Scholarship settings</h3>{scholarships.map((scholarship) => (
            <article className="admin-scholarship-row" key={scholarship.id}>
              <div><button type="button" className="text-button" onClick={() => openScholarshipStudents(scholarship)}><strong>{scholarship.name}</strong></button><p>{scholarship.required_document_types.length ? `${scholarship.required_document_types.length} required document types` : 'No required documents selected'}{scholarship.eligibility_rules?.minimum_cgpa != null ? ` · Minimum CGPA ${scholarship.eligibility_rules.minimum_cgpa}/${scholarship.eligibility_rules.cgpa_scale}` : ''}{scholarship.eligibility_rules?.required_community_category ? ` · Category ${scholarship.eligibility_rules.required_community_category}` : ''}</p></div>
              <button type="button" className="secondary-action" onClick={() => openScholarshipStudents(scholarship)}>View students</button>
              <span className={`catalogue-state ${scholarship.is_active ? 'is-published' : ''}`}>{scholarship.is_active ? 'Published' : 'Hidden'}</span>
              <button type="button" className="secondary-action" onClick={() => toggleScholarship(scholarship)}>{scholarship.is_active ? 'Hide' : 'Publish'}</button>
              <details className="scholarship-requirement-editor"><summary>Edit rules</summary><form className="scholarship-admin-form" onSubmit={(event) => saveScholarshipRequirements(event, scholarship.id)}>
                <fieldset><legend>Required documents</legend>{documentTypes.map(([type, label]) => <label key={type}><input type="checkbox" name="required_document_types" value={type} defaultChecked={scholarship.required_document_types.includes(type) || (type === 'community_certificate' && Boolean(scholarship.eligibility_rules?.required_community_category))} />{label}</label>)}</fieldset>
                <label>Minimum marks (%)<input type="number" name="minimum_percentage" min="0" max="100" step="any" defaultValue={scholarship.eligibility_rules?.minimum_percentage ?? ''} /></label>
                <label>Minimum attendance (%)<input type="number" name="minimum_attendance_percent" min="0" max="100" step="any" defaultValue={scholarship.eligibility_rules?.minimum_attendance_percent ?? ''} /></label>
                <label>Maximum arrears<input type="number" name="maximum_arrears" min="0" step="1" defaultValue={scholarship.eligibility_rules?.maximum_arrears ?? ''} /></label>
                <label>Maximum annual family income (₹)<input type="number" name="maximum_annual_family_income" min="0" step="any" defaultValue={scholarship.eligibility_rules?.maximum_annual_family_income ?? ''} /></label>
                <fieldset className="cgpa-rules"><legend>CGPA eligibility</legend>
                  <label>Minimum CGPA<input type="number" name="minimum_cgpa" min="0" max="100" step="any" defaultValue={scholarship.eligibility_rules?.minimum_cgpa ?? ''} /></label>
                  <label>CGPA scale maximum<input type="number" name="cgpa_scale" min="0.01" max="100" step="any" defaultValue={scholarship.eligibility_rules?.cgpa_scale ?? 10} /></label>
                  <p>Students must have a CGPA on this same scale to see this scholarship.</p>
                </fieldset>
                <fieldset className="cgpa-rules"><legend>Community eligibility</legend>
                  <label>Required community category<input type="text" name="required_community_category" maxLength="80" defaultValue={scholarship.eligibility_rules?.required_community_category ?? ''} placeholder="For example: BC" /></label>
                  <p>When set, the community certificate is required and OCR compares the printed category with this value for the AI suggestion.</p>
                </fieldset>
                <button type="submit" disabled={requirementsBusyId === scholarship.id}>{requirementsBusyId === scholarship.id ? 'Saving...' : 'Save requirements'}</button>
              </form></details>
            </article>
          ))}</div> : <p className="empty-state">No scholarships have been created yet.</p>}
          <section className="demo-dashboard" aria-labelledby="demo-scholarships-title">
            <div className="dashboard-heading"><div><p className="eyebrow">Scholarship catalogue</p><h3 id="demo-scholarships-title">Published scholarships</h3></div><p>Select a scholarship to view its registered-student list and applications.</p></div>
            <div className="demo-scholarship-grid">{scholarships.filter((scholarship) => scholarship.is_active).map((scholarship) => {
              const sampleRecords = demoScholarships.find((item) => item.name.toLowerCase() === scholarship.name.toLowerCase());
              return <button type="button" className="demo-scholarship-card" key={scholarship.id} onClick={() => sampleRecords ? openDemoScholarship(sampleRecords) : openScholarshipStudents(scholarship)}>
                <span className="demo-card-icon" aria-hidden="true">✦</span><strong>{scholarship.name}</strong><span>{scholarship.description}</span>
                <span className="demo-student-count">{sampleRecords ? sampleRecords.students.length : 'View'}<small>{sampleRecords ? ' registered students' : ' registered students'}</small></span>
              </button>;
            })}</div>
          </section>
        </div>
      </details>
      </>}
      {adminScreen === 'students' && <section className="admin-review">
        <p className="eyebrow">Published scholarship</p><h3>{activeScholarship?.name}</h3>
        <h4>{activeScholarship?.is_demo ? activeScholarship.students.length : scholarshipStudents.length} registered students</h4>
        {activeScholarship?.is_demo ? <div className="demo-student-list">{activeScholarship.students.map((student) => <button type="button" key={student.id} onClick={() => { setSelectedDemoStudent(student); setAdminScreen('student'); }}>
          <span><strong>{student.fullName}</strong><small>{student.email} · Roll no. {student.rollNumber}</small></span><StatusBadge status={demoDecisions[student.id] || 'Submitted'} /><span aria-hidden="true">›</span>
        </button>)}</div> : studentsLoading ? <p>Loading registered students...</p> : scholarshipStudents.length ? <div className="demo-student-list">{scholarshipStudents.map((application) => <button type="button" key={application.id} onClick={() => openApplication(application.id)}>
          <span><strong>{application.student_name}</strong><small>{application.student_email} · Application {application.application_number}</small></span><StatusBadge status={application.status} /><span aria-hidden="true">›</span>
        </button>)}</div> : <p className="empty-state">No students have registered for this scholarship yet.</p>}
      </section>}
      {adminScreen === 'student' && selectedDemoStudent && activeScholarship?.is_demo && <article className="admin-review demo-student-detail">
        <div className="application-heading"><div><p className="eyebrow">Application · {activeScholarship.name}</p><h3>{selectedDemoStudent.fullName}</h3></div><StatusBadge status={demoDecisions[selectedDemoStudent.id] || 'Submitted'} /></div>
        <div className="demo-detail-grid"><p><strong>Email</strong>{selectedDemoStudent.email}</p><p><strong>Roll number</strong>{selectedDemoStudent.rollNumber}</p><p><strong>Course</strong>{selectedDemoStudent.course}</p><p><strong>Year of study</strong>{selectedDemoStudent.year}</p><p><strong>Previous award</strong>{selectedDemoStudent.previousAward}</p><p><strong>Previous-year marks</strong>{selectedDemoStudent.marks}%</p><p><strong>Attendance</strong>{selectedDemoStudent.attendance}%</p><p><strong>Annual family income</strong>₹{selectedDemoStudent.familyIncome.toLocaleString('en-IN')}</p></div>
        <h4>Documents on file</h4><ul>{selectedDemoStudent.documents.map((document) => <li key={document.filename}>{document.type}: {document.filename} <span className="demo-file-note">(illustrative file name; no document is uploaded)</span></li>)}</ul>
        <p className="notice-box">These are illustrative student records. Accept and reject actions update this preview only and do not affect a submitted application.</p>
        {['Verified', 'Rejected'].includes(demoDecisions[selectedDemoStudent.id])
          ? <p className="success-box" role="status">Decision recorded for this illustrative preview. Final applications show their decision in the student&apos;s application list.</p>
          : <div className="demo-decision-actions"><button type="button" onClick={() => setDemoDecisions((current) => ({ ...current, [selectedDemoStudent.id]: 'Verified' }))}>Accept application</button><button type="button" className="secondary-action" onClick={() => setDemoDecisions((current) => ({ ...current, [selectedDemoStudent.id]: 'Rejected' }))}>Reject application</button></div>}
      </article>}
      {adminScreen === 'student' && selected && !selectedDemoStudent && <div className="admin-review">
        <div className="application-heading"><div><p className="eyebrow">{selected.application_number}</p><h3>{selected.scholarship_scheme} · {selected.renewal_year}</h3></div><StatusBadge status={selected.status} /></div>
        <p>Student: {selected.student_information?.full_name || selected.student?.email} · {selected.student?.email}</p>
        {renderSection('Student information', selected.student_information)}
        {renderSection('Previous scholarship', selected.previous_scholarship)}
        {renderSection('Academic information', selected.academic_details)}
        {renderSection('Financial information', selected.financial_details)}
        {selected.assessment?.missing_document_warnings?.length > 0 && <p className="warning-box">Required or requested documents missing: {selected.assessment.missing_document_warnings.map((type) => type.replaceAll('_', ' ')).join(', ')}.</p>}
        {selected.assessment?.eligibility_checks?.unconfigured && <p className="warning-box">Scheme-specific eligibility rules are not configured. Eligibility is undetermined pending configuration and review.</p>}
        <button type="button" className="secondary-action" onClick={runApplicationAIReview} disabled={aiReviewBusy}>{aiReviewBusy ? 'Reviewing OCR text...' : 'Analyze OCR and prepare review list'}</button>
        {selected.ai_review && <AIReviewPanel report={selected.ai_review} admin />}
        <h3>Documents</h3>
        {selected.documents?.length ? <div className="admin-ocr-documents">{selected.documents.map((document) => (
          <article className="admin-ocr-document" key={document.id}>
            <p><strong>{document.document_type}</strong> · <a href={apiBaseUrl + '/api/applications/' + selected.id + '/documents/' + document.id} target="_blank" rel="noreferrer">{document.original_filename}</a></p>
            <p className="ocr-document-status">OCR status: {document.ocr_status}{document.ocr_method ? ' · ' + document.ocr_method.replaceAll('_', ' ') : ''}{document.ocr_confidence != null ? ' · average confidence ' + document.ocr_confidence + '%' : ''}</p>
            {document.ocr_error && <p className="ocr-document-message">{document.ocr_error}</p>}
            {document.ocr_text ? <details className="ocr-text-details"><summary>View extracted text</summary><pre>{document.ocr_text}</pre><p>OCR may misread names, dates, amounts, or numbers. Verify the document manually before making a decision.</p></details> : <p className="ocr-document-message">No extracted text is available yet.</p>}
            <button type="button" className="secondary-action" onClick={() => runDocumentOcr(document)} disabled={ocrBusyId === document.id}>{ocrBusyId === document.id ? 'Reading document...' : 'Run OCR again'}</button>
          </article>
        ))}</div> : <p>No documents uploaded.</p>}
        <form className="review-form" onSubmit={saveReview}>
          <label>Review status<select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value)}>{(reviewTransitions[selected.status] || []).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Administrative feedback<textarea rows="4" maxLength="4000" value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
          <fieldset><legend>Documents requested from student</legend>{documentTypes.map(([type, label]) => <label key={type}><input type="checkbox" checked={missing.includes(type)} onChange={() => toggleMissing(type)} />{label}</label>)}</fieldset>
          <button type="submit" disabled={!(reviewTransitions[selected.status] || []).length}>Save review</button>
        </form>
        {['Submitted', 'Under Review', 'Resubmitted'].includes(selected.status) && <div className="demo-decision-actions"><button type="button" onClick={() => decideApplication('Verified')}>Accept application</button><button type="button" className="secondary-action" onClick={() => decideApplication('Rejected')}>Reject application</button></div>}
        {notice && <p className="success-box" role="status">{notice}</p>}
      </div>}
    </section>
  );
}
