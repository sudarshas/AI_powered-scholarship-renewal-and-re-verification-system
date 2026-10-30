import express from 'express';
import multer from 'multer';
import { pathToFileURL } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const configuredAiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const aiServiceUrl = (/^https?:\/\//i.test(configuredAiServiceUrl)
  ? configuredAiServiceUrl
  : `http://${configuredAiServiceUrl}`).replace(/\/+$/, '');
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
const isProduction = process.env.NODE_ENV === 'production';
const aiServiceTimeoutMs = Number(process.env.AI_SERVICE_TIMEOUT_MS || 240000);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:5174,http://127.0.0.1:5174')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1) {
  throw new Error('MAX_UPLOAD_BYTES must be a positive whole number');
}
if (!Number.isInteger(aiServiceTimeoutMs) || aiServiceTimeoutMs < 1000) {
  throw new Error('AI_SERVICE_TIMEOUT_MS must be at least 1000 milliseconds');
}
if (isProduction) {
  if (!process.env.AI_SERVICE_URL || /localhost|127\.0\.0\.1/i.test(aiServiceUrl)) {
    throw new Error('Set AI_SERVICE_URL to the private FastAPI service address in production');
  }
  if (!process.env.ALLOWED_ORIGINS || [...allowedOrigins].some((origin) => !origin.startsWith('https://'))) {
    throw new Error('Set ALLOWED_ORIGINS to the exact HTTPS frontend origin(s) in production');
  }
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || (isProduction ? 1 : false));
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '128kb' }));

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (request.method === 'OPTIONS') return response.sendStatus(204);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && origin && !allowedOrigins.has(origin)) {
    return response.status(403).json({ detail: 'Request origin is not allowed' });
  }
  next();
});

const requestBuckets = new Map();
function rateLimit(maximum, windowMs) {
  return (request, response, next) => {
    const now = Date.now();
    const key = `${request.ip}:${request.baseUrl}${request.path}`;
    let bucket = requestBuckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      requestBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) {
      response.setHeader('Retry-After', Math.ceil((bucket.expiresAt - now) / 1000));
      return response.status(429).json({ detail: 'Too many requests. Please wait and try again.' });
    }
    if (requestBuckets.size > 10000) {
      for (const [bucketKey, value] of requestBuckets) {
        if (value.expiresAt <= now) requestBuckets.delete(bucketKey);
      }
    }
    next();
  };
}
const authRateLimit = rateLimit(12, 15 * 60 * 1000);
const writeRateLimit = rateLimit(120, 15 * 60 * 1000);

async function forwardToAi(request, response, path, options = {}) {
  const method = options.method || request.method;
  const headers = {};
  if (request.headers.cookie) headers.Cookie = request.headers.cookie;
  if (options.contentType) headers['Content-Type'] = options.contentType;
  else if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';
  try {
    const aiResponse = await fetch(`${aiServiceUrl}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(aiServiceTimeoutMs),
      ...(method !== 'GET' && method !== 'HEAD'
        ? { body: options.body === undefined ? JSON.stringify(request.body ?? {}) : options.body }
        : {}),
    });
    const setCookies = aiResponse.headers.getSetCookie?.();
    if (setCookies?.length) response.setHeader('Set-Cookie', setCookies);
    else if (aiResponse.headers.get('set-cookie')) response.setHeader('Set-Cookie', aiResponse.headers.get('set-cookie'));

    if (options.responseType === 'file') {
      for (const header of ['content-type', 'content-disposition']) {
        const value = aiResponse.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      response.status(aiResponse.status).send(Buffer.from(await aiResponse.arrayBuffer()));
      return;
    }
    const result = await aiResponse.json();
    response.status(aiResponse.status).json(result);
  } catch (_error) {
    response.status(502).json({
      service: 'scholarship-backend',
      error: 'Unable to connect to the AI service. Check that it is running and AI_SERVICE_URL is correct.',
    });
  }
}

app.get('/api/health', async (_request, response) => {
  try {
    const aiResponse = await fetch(`${aiServiceUrl}/health`);
    if (!aiResponse.ok) {
      return response.status(502).json({
        service: 'scholarship-backend',
        error: `AI service returned status ${aiResponse.status}`,
      });
    }
    const health = await aiResponse.json();
    response.json({ service: 'scholarship-backend', status: 'ok', aiService: health });
  } catch (_error) {
    response.status(502).json({
      service: 'scholarship-backend',
      error: 'Unable to connect to the AI service. Check that it is running and AI_SERVICE_URL is correct.',
    });
  }
});

app.post('/api/renewal/check', (request, response) =>
  forwardToAi(request, response, '/renewal/check'));

app.post('/api/auth/register', authRateLimit, (request, response) =>
  forwardToAi(request, response, '/auth/register'));
app.post('/api/auth/change-password', authRateLimit, (request, response) =>
  forwardToAi(request, response, '/auth/change-password'));
app.post('/api/auth/login', authRateLimit, (request, response) =>
  forwardToAi(request, response, '/auth/login'));
app.post('/api/auth/logout', writeRateLimit, (request, response) =>
  forwardToAi(request, response, '/auth/logout'));
app.get('/api/auth/me', (request, response) =>
  forwardToAi(request, response, '/auth/me'));
app.get('/api/students/me', (request, response) =>
  forwardToAi(request, response, '/students/me'));
app.get('/api/students/me/academic-profile', (request, response) =>
  forwardToAi(request, response, '/students/me/academic-profile'));
app.post('/api/admin/students', writeRateLimit, (request, response) =>
  forwardToAi(request, response, '/admin/students'));
app.get('/api/admin/students/academic-profiles', (request, response) =>
  forwardToAi(request, response, '/admin/students/academic-profiles'));
app.put('/api/admin/students/:studentId/academic-profile', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/students/${encodeURIComponent(request.params.studentId)}/academic-profile`));
app.get('/api/scholarships', (request, response) =>
  forwardToAi(request, response, '/scholarships'));
app.post('/api/admin/scholarships', writeRateLimit, (request, response) =>
  forwardToAi(request, response, '/admin/scholarships'));
app.get('/api/admin/scholarships/:scholarshipId/applications', (request, response) =>
  forwardToAi(request, response, `/admin/scholarships/${encodeURIComponent(request.params.scholarshipId)}/applications`));
app.patch('/api/admin/scholarships/:scholarshipId/status', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/scholarships/${encodeURIComponent(request.params.scholarshipId)}/status`));
app.patch('/api/admin/scholarships/:scholarshipId/requirements', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/scholarships/${encodeURIComponent(request.params.scholarshipId)}/requirements`));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    const permitted = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (!permitted.has(file.mimetype)) return callback(new Error('Only PDF, JPEG, and PNG documents are accepted'));
    callback(null, true);
  },
}).single('file');

function parseUpload(request, response, next) {
  upload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    const tooMany = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT';
    response.status(tooLarge ? 413 : 400).json({
      detail: tooLarge
        ? `File exceeds the ${maxUploadBytes} byte upload limit`
        : tooMany
          ? 'Upload one document at a time'
          : error.message || 'Invalid document upload',
    });
  });
}

function detectedType(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return null;
}

app.post('/api/applications/:applicationId/documents', writeRateLimit, parseUpload, (request, response) => {
  if (!request.file) return response.status(400).json({ detail: 'Choose one document to upload' });
  const contentType = detectedType(request.file.buffer);
  const extension = request.file.originalname.split('.').pop()?.toLowerCase();
  const expectedExtension = { 'application/pdf': 'pdf', 'image/jpeg': ['jpg', 'jpeg'], 'image/png': 'png' }[contentType];
  const extensionMatches = Array.isArray(expectedExtension)
    ? expectedExtension.includes(extension)
    : extension === expectedExtension;
  if (!contentType || contentType !== request.file.mimetype || !extensionMatches) {
    return response.status(415).json({ detail: 'File extension, MIME type, and file signature must match PDF, JPEG, or PNG content' });
  }
  const body = JSON.stringify({
    document_type: request.body.document_type,
    original_filename: request.file.originalname,
    content_type: contentType,
    content_base64: request.file.buffer.toString('base64'),
  });
  return forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/documents`, {
    method: 'POST',
    body,
    contentType: 'application/json',
  });
});

app.get('/api/applications', (request, response) =>
  forwardToAi(request, response, '/applications'));
app.post('/api/applications', writeRateLimit, (request, response) =>
  forwardToAi(request, response, '/applications'));
app.get('/api/applications/:applicationId', (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}`));
app.post('/api/applications/:applicationId/ai-review', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/ai-review`));
app.get('/api/applications/:applicationId/ai-review', (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/ai-review`));
app.put('/api/applications/:applicationId', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}`));
app.post('/api/applications/:applicationId/submit', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/submit`));
app.get('/api/applications/:applicationId/documents', (request, response) =>
  forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/documents`));
app.get('/api/applications/:applicationId/documents/:documentId', (request, response) => {
  const preview = request.query.preview === 'true' ? '?preview=true' : '';
  return forwardToAi(request, response, `/applications/${encodeURIComponent(request.params.applicationId)}/documents/${encodeURIComponent(request.params.documentId)}${preview}`, { responseType: 'file' });
});

app.get('/api/admin/applications', (request, response) => {
  const query = new URLSearchParams(request.query).toString();
  forwardToAi(request, response, `/admin/applications${query ? `?${query}` : ''}`);
});
app.get('/api/admin/applications/:applicationId', (request, response) =>
  forwardToAi(request, response, `/admin/applications/${encodeURIComponent(request.params.applicationId)}`));
app.post('/api/admin/applications/:applicationId/ai-review', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/applications/${encodeURIComponent(request.params.applicationId)}/ai-review`));
app.get('/api/admin/applications/:applicationId/ai-review', (request, response) =>
  forwardToAi(request, response, `/admin/applications/${encodeURIComponent(request.params.applicationId)}/ai-review`));
app.post('/api/admin/applications/:applicationId/documents/:documentId/ocr', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/applications/${encodeURIComponent(request.params.applicationId)}/documents/${encodeURIComponent(request.params.documentId)}/ocr`));
app.patch('/api/admin/applications/:applicationId/review', writeRateLimit, (request, response) =>
  forwardToAi(request, response, `/admin/applications/${encodeURIComponent(request.params.applicationId)}/review`));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`Backend API listening at http://localhost:${port}`);
  });
}

export { app };
