'use strict';

// MinIO (S3-compatible) object storage for guest/event photos.
// Binary lives in MinIO; Postgres only stores metadata. Creds via env only.
const crypto = require('crypto');

let Minio = null;
try { Minio = require('minio'); } catch (_) { /* dep not installed yet */ }

const ENDPOINT = process.env.MINIO_ENDPOINT || '127.0.0.1';
const PORT = parseInt(process.env.MINIO_PORT || '9000', 10);
const USE_SSL = String(process.env.MINIO_USE_SSL || 'false') === 'true';
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY || '';
const SECRET_KEY = process.env.MINIO_SECRET_KEY || '';
const BUCKET = process.env.MINIO_BUCKET || 'esuhai-crm';
const PRESIGN_TTL = parseInt(process.env.MINIO_PRESIGN_TTL || '300', 10); // 5 min

let client = null;
function getClient() {
  if (!Minio) throw new Error('minio SDK not installed');
  if (!ACCESS_KEY || !SECRET_KEY) throw new Error('MinIO credentials not configured');
  if (!client) {
    client = new Minio.Client({ endPoint: ENDPOINT, port: PORT, useSSL: USE_SSL, accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
  }
  return client;
}

function isConfigured() { return !!(Minio && ACCESS_KEY && SECRET_KEY); }

async function ensureBucket() {
  if (!isConfigured()) { console.warn('[crm-storage] MinIO not configured — photo upload disabled'); return false; }
  const c = getClient();
  const exists = await c.bucketExists(BUCKET).catch(() => false);
  if (!exists) await c.makeBucket(BUCKET).catch((e) => { throw e; });
  console.log(`[crm-storage] MinIO ready (bucket ${BUCKET})`);
  return true;
}

async function putObject(guestId, buffer, contentType) {
  const c = getClient();
  const ext = (contentType && contentType.split('/')[1]) ? '.' + contentType.split('/')[1].replace(/[^a-z0-9]/gi, '') : '';
  const key = `guests/${guestId}/${crypto.randomUUID()}${ext}`;
  await c.putObject(BUCKET, key, buffer, buffer.length, { 'Content-Type': contentType || 'application/octet-stream' });
  return key;
}

// Put at a caller-specified deterministic key (batch import idempotency).
// Unlike putObject (random UUID), the caller controls the key so re-running an
// import maps to the same object instead of creating duplicates.
async function putObjectAt(objectKey, buffer, contentType) {
  const c = getClient();
  await c.putObject(BUCKET, objectKey, buffer, buffer.length, { 'Content-Type': contentType || 'application/octet-stream' });
  return objectKey;
}

// Short-lived presigned GET — private bucket, never public list.
async function presignGet(objectKey) {
  const c = getClient();
  return c.presignedGetObject(BUCKET, objectKey, PRESIGN_TTL);
}

module.exports = { isConfigured, ensureBucket, putObject, putObjectAt, presignGet, BUCKET };
