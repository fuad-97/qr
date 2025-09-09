# PDF Uploader with QR ("التقرير كامل")

## Run locally

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 and upload a PDF. The processed file will be available under `/files/...`.

## API

- POST `/upload-pdf`: multipart form field `file` (PDF). Returns JSON with `download_url`.
- GET `/files/{filename}`: serves processed PDFs.
- GET `/healthz`: health check.

