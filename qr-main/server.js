const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AWS = require('aws-sdk');
const app = express();
const port = 3000;

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

// ensure uploads directory exists
const uploadsDirPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDirPath)) {
  fs.mkdirSync(uploadsDirPath, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDirPath);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

// قاعدة بيانات مؤقتة: ربط hash باسم الملف المرفوع
const reports = {
  "123abc": { fileName: "report1.pdf", status: "أصلي" }
};

// إعداد S3 client لـ Cloudflare R2
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
});

// دالة رفع الملف إلى R2
async function uploadToR2(filePath, key) {
  const fileStream = fs.createReadStream(filePath);

  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ACL: 'public-read', // رابط مباشر
  };

  const result = await s3.upload(params).promise();
  fs.unlinkSync(filePath); // حذف الملف المحلي بعد الرفع
  return result.Location; // رابط مباشر للملف
}

// مسار التحقق
app.get('/verify', (req, res) => {
  const hash = req.query.hash;
  if(!hash) return res.send("❌ لا يوجد hash للتحقق");

  const report = reports[hash];
  if(report){
    // إعادة التوجيه مباشرة لعرض الملف المختوم
    return res.redirect(`/file?hash=${encodeURIComponent(hash)}`);
  } else {
    res.send(`<h2>❌ هذا التقرير غير أصلي أو تم التعديل</h2>`);
  }
});

// مسار رفع الملف الكامل مع رفعه إلى R2
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'لم يتم إرسال ملف' });
    }

    const providedHash = req.body && req.body.hash ? String(req.body.hash) : undefined;
    const savedFileName = req.file.filename;
    const localPath = req.file.path;

    // رفع الملف إلى R2
    const r2Url = await uploadToR2(localPath, savedFileName);

    // تسجيل الملف في قاعدة البيانات المؤقتة باستخدام الهاش
    if (providedHash) {
      reports[providedHash] = { fileName: savedFileName, status: 'أصلي', url: r2Url };
    }

    return res.json({ ok: true, fileName: savedFileName, r2Url });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ ok: false, message: 'خطأ أثناء الرفع' });
  }
});

// مسار لعرض الملف كاملاً عند المسح (QR)
app.get('/file', (req, res) => {
  const hash = req.query.hash;
  if (!hash) {
    return res.status(400).send('❌ لا يوجد hash');
  }
  const report = reports[hash];
  if (!report) {
    return res.status(404).send('❌ لم يتم العثور على ملف مرتبط بهذا الهاش');
  }
  // عرض الملف عبر الرابط المباشر من R2
  if (report.url) {
    return res.redirect(report.url); // إعادة التوجيه للرابط المباشر
  }

  const filePath = path.join(uploadsDirPath, report.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('❌ الملف غير موجود على الخادم');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${report.fileName}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
