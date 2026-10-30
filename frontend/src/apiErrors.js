const fallbackMessage = 'The request could not be completed. Please review the information and try again.';

function fieldLabel(location) {
  const field = Array.isArray(location) ? location.at(-1) : location;
  if (typeof field !== 'string' || field === 'body' || field === 'query' || field === 'path') return '';
  return field.replaceAll('_', ' ');
}

export function apiErrorMessage(payload, fallback = fallbackMessage) {
  const detail = payload?.detail;

  if (typeof detail === 'string' && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    if (detail.some((issue) => issue?.type === 'extra_forbidden')) {
      return 'The request contains unsupported information. Refresh the page and try again.';
    }

    const missingFields = [...new Set(detail
      .filter((issue) => issue?.type === 'missing')
      .map((issue) => fieldLabel(issue.loc))
      .filter(Boolean))];
    if (missingFields.length) {
      return `Please complete the required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.slice(0, 4).join(', ')}${missingFields.length > 4 ? ', and others' : ''}.`;
    }
    return 'Some submitted information is invalid. Check the form and try again.';
  }

  if (detail && typeof detail === 'object') {
    const hasFormErrors = Array.isArray(detail.form_validation_errors) && detail.form_validation_errors.length > 0;
    const hasMissingDocuments = Array.isArray(detail.missing_document_warnings) && detail.missing_document_warnings.length > 0;
    if (hasFormErrors && hasMissingDocuments) {
      return 'Complete the required application details and upload the listed documents before submitting.';
    }
    if (hasFormErrors) {
      return 'Some required application details are missing or invalid. Review the form and try again.';
    }
    if (hasMissingDocuments) {
      return `Required documents are missing: ${detail.missing_document_warnings.join(', ')}.`;
    }
    return fallback;
  }

  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  return fallback;
}
