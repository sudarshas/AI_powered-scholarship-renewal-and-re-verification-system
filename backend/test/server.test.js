import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';

let apiServer;
let upstreamServer;
let apiBaseUrl;
let forwardedRequests = [];

before(async () => {
  upstreamServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    forwardedRequests.push({ method: request.method, url: request.url, cookie: request.headers.cookie, body });
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ service: 'test-ai', status: 'ok' }));
    } else if (request.url === '/auth/login') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'scholarship_session=fake; HttpOnly; SameSite=Lax' });
      response.end(JSON.stringify({ id: 9, role: 'student' }));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ forwarded: true, body: body ? JSON.parse(body) : null }));
    }
  });
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${upstreamServer.address().port}`;
  process.env.MAX_UPLOAD_BYTES = '32';
  const { app } = await import('../server.js');
  apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

after(async () => {
  await Promise.all([apiServer, upstreamServer].map((server) => new Promise((resolve) => server.close(resolve))));
});

test('preserves health response and forwards auth cookies in both directions', async () => {
  const healthResponse = await fetch(`${apiBaseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    service: 'scholarship-backend',
    status: 'ok',
    aiService: { service: 'test-ai', status: 'ok' },
  });

  const loginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'student@example.test', password: 'not-a-real-secret' }),
  });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/);
  assert.deepEqual(await loginResponse.json(), { id: 9, role: 'student' });

  const privateResponse = await fetch(`${apiBaseUrl}/api/auth/me`, { headers: { Cookie: 'scholarship_session=fake' } });
  assert.equal(privateResponse.status, 200);
  assert.equal(forwardedRequests.at(-1).cookie, 'scholarship_session=fake');
});

test('checks upload MIME, extension, signature, and size before forwarding', async () => {
  const validForm = new FormData();
  validForm.append('document_type', 'marksheet');
  validForm.append('file', new Blob(['%PDF-1.7\nmock test bytes'], { type: 'application/pdf' }), 'marksheet.pdf');
  const validResponse = await fetch(`${apiBaseUrl}/api/applications/1/documents`, {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:5174' }, body: validForm,
  });
  assert.equal(validResponse.status, 200);
  const sentDocument = JSON.parse(forwardedRequests.at(-1).body);
  assert.equal(sentDocument.document_type, 'marksheet');
  assert.equal(sentDocument.content_type, 'application/pdf');
  assert.equal(Buffer.from(sentDocument.content_base64, 'base64').subarray(0, 5).toString(), '%PDF-');

  const invalidForm = new FormData();
  invalidForm.append('document_type', 'marksheet');
  invalidForm.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'not-a-pdf.pdf');
  const forwardedBeforeInvalid = forwardedRequests.length;
  const invalidResponse = await fetch(`${apiBaseUrl}/api/applications/1/documents`, {
    method: 'POST', body: invalidForm,
  });
  assert.equal(invalidResponse.status, 415);
  assert.equal(forwardedRequests.length, forwardedBeforeInvalid);

  const oversizedForm = new FormData();
  oversizedForm.append('document_type', 'marksheet');
  oversizedForm.append('file', new Blob(['%PDF-' + 'a'.repeat(40)], { type: 'application/pdf' }), 'large.pdf');
  const oversizedResponse = await fetch(`${apiBaseUrl}/api/applications/1/documents`, {
    method: 'POST', body: oversizedForm,
  });
  assert.equal(oversizedResponse.status, 413);
});

test('rejects untrusted mutation origins and throttles repeated sign-in requests', async () => {
  const rejected = await fetch(`${apiBaseUrl}/api/auth/logout`, {
    method: 'POST', headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(rejected.status, 403);

  let lastResponse;
  for (let index = 0; index < 13; index += 1) {
    lastResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rate@example.test', password: 'not-a-real-secret' }),
    });
  }
  assert.equal(lastResponse.status, 429);
});
