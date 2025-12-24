const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
// Load environment variables from .env if present
try { require('dotenv').config(); } catch(_) {}
const B2 = require('backblaze-b2');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const reportsPassword = process.env.REPORTS_PASSWORD || '944221';
const REPORTS_STORE = path.join(__dirname, 'reports-store.json');

// Basic CORS for cross-origin requests
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// static files (serve index.html and assets)
app.use(express.static(__dirname));

// Multer in-memory storage (no disk writes)
const upload = multer({ storage: multer.memoryStorage() });

// Multer error handler to avoid generic 500s
function multerErrorHandler(err, req, res, next){
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, message: `Multer error: ${err.code}` });
  }
  next(err);
}
app.use(multerErrorHandler);

// Simple Basic Auth for /reports if password is configured
function requireReportsPassword(req, res, next){
  if (!reportsPassword) {
    return res.status(503).send('Reports password not configured. Set REPORTS_PASSWORD.');
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith('basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Reports"');
    return res.status(401).send('Authentication required.');
  }
  try {
    const decoded = Buffer.from(auth.split(' ')[1] || '', 'base64').toString('utf8');
    const [, pass = ''] = decoded.split(':');
    if (pass === reportsPassword) return next();
  } catch (_) {}
  res.setHeader('WWW-Authenticate', 'Basic realm="Reports"');
  return res.status(401).send('Invalid credentials.');
}

// إعداد Backblaze B2
// Render envs expected: B2_ACCOUNT_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, B2_BUCKET_NAME
// Fallbacks kept for compatibility with older naming
const b2KeyId = process.env.B2_ACCOUNT_ID || process.env.B2_APPLICATION_KEY_ID || process.env.B2_KEY_ID;
const b2AppKey = process.env.B2_APPLICATION_KEY || process.env.B2_APP_KEY;
const b2BucketIdEnv = process.env.B2_BUCKET_ID || '';
const b2BucketNameEnv = process.env.B2_BUCKET_NAME || '';
const b2PublicBaseOverride = process.env.B2_PUBLIC_BASE_URL || '';

let b2; // instance
let b2Config = { enabled: false, bucketId: '', bucketName: '', publicBaseUrl: '' };
let b2InitPromise = null;
const B2_AUTH_TTL_MS = 1000 * 60 * 60 * 23; // refresh auth before 24h expiry
let b2AuthPromise = null;
let b2LastAuthAt = 0;
let b2LastAuthResponse = null;

async function ensureB2Authorized(force = false){
  if (!b2KeyId || !b2AppKey) {
    throw new Error('B2 credentials are not configured');
  }
  const now = Date.now();
  if (!force && b2LastAuthAt && (now - b2LastAuthAt) < B2_AUTH_TTL_MS && b2LastAuthResponse) {
    return b2LastAuthResponse;
  }
  if (b2AuthPromise) {
    return b2AuthPromise;
  }
  if (!b2) {
    b2 = new B2({ applicationKeyId: b2KeyId, applicationKey: b2AppKey });
  }
  b2AuthPromise = (async () => {
    const auth = await b2.authorize();
    b2LastAuthAt = Date.now();
    b2LastAuthResponse = auth;
    return auth;
  })();
  try {
    return await b2AuthPromise;
  } finally {
    b2AuthPromise = null;
  }
}

function isExpiredAuthError(err){
  const resp = err && err.response;
  const code = resp && resp.data && resp.data.code ? resp.data.code : err && err.code;
  const status = resp && resp.status ? resp.status : err && err.status;
  return code === 'expired_auth_token' || code === 'bad_auth_token' || status === 401;
}

async function uploadFileToB2(cfg, targetName, buffer, mimeType){
  const attempt = async (forceAuth) => {
    await ensureB2Authorized(forceAuth);
    const uploadUrlResp = await b2.getUploadUrl({ bucketId: cfg.bucketId });
    const uploadUrl = uploadUrlResp.data.uploadUrl;
    const uploadAuthToken = uploadUrlResp.data.authorizationToken;
    return b2.uploadFile({
      uploadUrl,
      uploadAuthToken,
      fileName: targetName,
      data: buffer,
      mime: mimeType
    });
  };

  try {
    return await attempt(false);
  } catch (err) {
    if (isExpiredAuthError(err)) {
      console.warn('B2 auth token expired, re-authorizing and retrying upload');
      return attempt(true);
    }
    throw err;
  }
}

async function ensureB2Ready(){
  if (b2InitPromise) return b2InitPromise;
  b2InitPromise = (async () => {
    // إذا لم تتوفر بيانات الاعتماد، اعتبر B2 غير مفعّل
    if (!b2KeyId || !b2AppKey || (!b2BucketIdEnv && !b2BucketNameEnv)) {
      b2Config.enabled = false;
      return b2Config;
    }
    const auth = await ensureB2Authorized(true);
    const downloadUrl = auth && auth.data && auth.data.downloadUrl ? auth.data.downloadUrl : '';

    let bucketId = b2BucketIdEnv;
    let bucketName = b2BucketNameEnv;
    if (!bucketId || !bucketName) {
      let found;
      // Try listBuckets (works with master key). If it fails (restricted key), fall back to getBucket
      try {
        const list = await b2.listBuckets({ accountId: auth.data.accountId });
        const buckets = (list && list.data && list.data.buckets) || [];
        if (bucketId) {
          found = buckets.find(b => b.bucketId === bucketId);
        } else if (bucketName) {
          found = buckets.find(b => b.bucketName === bucketName);
        }
      } catch (listErr) {
        // ignore, will try getBucket fallback below
      }
      if (!found) {
        try {
          if (bucketId) {
            const gb = await b2.getBucket({ bucketId });
            found = gb && gb.data ? gb.data : null;
          } else if (bucketName) {
            const gb = await b2.getBucket({ bucketName });
            found = gb && gb.data ? gb.data : null;
          }
        } catch (gbErr) {
          // no-op, handled below
        }
      }
      if (!found) throw new Error('B2 bucket غير موجود. تحقق من B2_BUCKET_ID/B2_BUCKET_NAME');
      bucketId = found.bucketId;
      bucketName = found.bucketName;
    }

    const publicBaseUrl = b2PublicBaseOverride || downloadUrl;
    b2Config = { enabled: true, bucketId, bucketName, publicBaseUrl };
    return b2Config;
  })().catch(err => {
    try {
      const extra = err && err.response && err.response.data ? JSON.stringify(err.response.data) : '';
      console.error('B2 init error:', err && err.message ? err.message : err, extra);
    } catch(_) {
      console.error('B2 init error:', err && err.message ? err.message : err);
    }
    b2Config.enabled = false;
    return b2Config;
  });
  return b2InitPromise;
}

// قاعدة بيانات مؤقتة: ربط hash باسم الملف المرفوع
function loadReports(){
  try {
    const raw = fs.readFileSync(REPORTS_STORE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {}
  return {
    "123abc": { fileName: "report1.pdf", status: "????�?�?", createdAt: new Date().toISOString() }
  };
}

function saveReports(data){
  try {
    fs.writeFileSync(REPORTS_STORE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist reports:", err && err.message ? err.message : err);
  }
}

const reports = loadReports();
saveReports(reports);

// صفحة عرض جميع التقارير المختومة
app.use('/reports', requireReportsPassword);
app.get('/reports', (req, res) => {
  res.sendFile(path.join(__dirname, 'reports.html'));
});

// مسار التحقق
app.get('/verify', (req, res) => {
  const hash = req.query.hash;
  if(!hash) return res.send("❌ لا يوجد hash للتحقق");

  const report = reports[hash];
  if(report){
    res.send(`<h2>✅ التقرير أصلي</h2>
              <p>اسم الملف: ${report.fileName}</p>
              <p><a href="/file?hash=${hash}" target="_blank">📄 عرض الملف</a></p>
              ${report.fileUrl ? `<p><a href="${report.fileUrl}" target="_blank">🌐 Backblaze B2</a></p>` : ''}`);
  } else {
    res.send(`<h2>❌ هذا التقرير غير أصلي أو تم التعديل</h2>`);
  }
});

// مسار التهيئة/الإعداد للعميل
app.get('/config', async (req, res) => {
  const cfg = await ensureB2Ready();
  res.json({
    b2Enabled: !!cfg.enabled,
    b2BucketName: cfg.bucketName || '',
    b2PublicBaseUrl: cfg.publicBaseUrl || ''
  });
});

// مسار رفع الملف الكامل
// expects multipart/form-data with field name "file" and optional "hash" and "targetName"
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'لم يتم إرسال ملف' });
    }

    const cfg = await ensureB2Ready();
    if (!cfg.enabled) {
      return res.status(500).json({ ok: false, message: 'خدمة التخزين غير مهيأة. يرجى ضبط متغيرات البيئة لـ Backblaze B2.' });
    }

    const providedHash = req.body && req.body.hash ? String(req.body.hash) : undefined;
    const computedHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const hash = providedHash || computedHash;
    const originalName = req.file.originalname || 'file';
    const targetName = req.body && req.body.targetName ? String(req.body.targetName) : originalName;
    const mimeType = req.file.mimetype || 'application/octet-stream';

    try {
      await uploadFileToB2(cfg, targetName, req.file.buffer, mimeType);

      // Build a public B2 URL and ensure proper encoding
      // Important: Preserve path separators in targetName (encode each segment, not the '/')
      const base = (cfg.publicBaseUrl || '').replace(/\/$/, '');
      const safeBucket = encodeURIComponent(cfg.bucketName);
      const safePath = String(targetName)
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/');
      const fileUrl = `${base}/file/${safeBucket}/${safePath}`;

      // سجل الملف في قاعدة البيانات المؤقتة باستخدام الهاش
      reports[hash] = {
        fileName: targetName,
        status: 'أصلي',
        fileUrl,
        mimeType,
        createdAt: new Date().toISOString()
      };
      saveReports(reports);

      return res.json({ ok: true, hash, fileName: targetName, fileUrl, mimeType, size: req.file.size || undefined });
    } catch (e) {
      try {
        const extra = e && e.response && e.response.data ? JSON.stringify(e.response.data) : '';
        console.error('B2 upload error:', e && e.message ? e.message : e, extra);
      } catch(_) {
        console.error('B2 upload error:', e && e.message ? e.message : e);
      }
      return res.status(502).json({ ok: false, message: 'تعذر رفع الملف إلى Backblaze B2' });
    }
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ ok: false, message: 'خطأ أثناء الرفع' });
  }
});

// مسار لعرض الملف كاملاً عند المسح (QR)
// مثال: /file?hash=abcdef
app.get('/file', (req, res) => {
  const hash = req.query.hash;
  if (!hash) {
    return res.status(400).send('❌ لا يوجد hash');
  }
  const report = reports[hash];
  if (!report || !report.fileUrl) {
    return res.status(404).send('❌ لم يتم العثور على ملف مرتبط بهذا الهاش');
  }
  // إعادة توجيه إلى Backblaze عبر الرابط المباشر
  return res.redirect(302, report.fileUrl);
});

// معالج أخطاء عام لضمان رسائل واضحة وعدم إرجاع 500 غير مفسرة
app.get('/api/reports', (req, res) => {
  const list = Object.entries(reports).map(([hash, data]) => ({
    hash,
    fileName: data.fileName || '',
    status: data.status || '',
    fileUrl: data.fileUrl || '',
    mimeType: data.mimeType || '',
    createdAt: data.createdAt || null
  }));
  list.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });
  return res.json({ ok: true, reports: list });
});

app.use((err, req, res, next) => {
  try {
    const msg = err && err.message ? err.message : 'خطأ غير متوقع';
    console.error('Unhandled error:', msg);
  } catch(_) {}
  if (res.headersSent) return next(err);
  return res.status(500).json({ ok: false, message: 'حدث خطأ غير متوقع. الرجاء المحاولة لاحقًا.' });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));




