import os
import uuid
from pathlib import Path
from typing import Tuple

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import segno
import fitz  # PyMuPDF


BASE_DIR: Path = Path(__file__).resolve().parent
UPLOAD_DIR: Path = BASE_DIR / "uploads"
OUTPUT_DIR: Path = BASE_DIR / "output"

# Ensure directories exist
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

app = FastAPI(title="PDF Uploader with QR Stamp", version="1.0.0")

# Mount static serving for processed PDFs
app.mount("/files", StaticFiles(directory=str(OUTPUT_DIR)), name="files")


def _save_upload_to_disk(upload: UploadFile) -> Path:
    """Persist uploaded file to disk with a unique name and return path."""
    if not upload.filename:
        raise HTTPException(status_code=400, detail="File must have a filename")

    file_extension = Path(upload.filename).suffix.lower()
    if file_extension != ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are allowed")

    unique_name = f"{uuid.uuid4().hex}{file_extension}"
    dest_path = UPLOAD_DIR / unique_name

    with dest_path.open("wb") as out_file:
        out_file.write(upload.file.read())

    return dest_path


def _generate_qr_png(text: str, scale: int = 6, border: int = 2) -> Path:
    """Generate a QR code PNG file for the given text and return its path."""
    qr = segno.make(text, error='h')
    tmp_qr_path = OUTPUT_DIR / f"qr_{uuid.uuid4().hex}.png"
    # scale controls pixel size per module; border sets quiet zone size
    qr.save(tmp_qr_path, scale=scale, border=border, dark='black', light='white')
    return tmp_qr_path


def _calculate_qr_rect(page_rect: fitz.Rect, qr_width_pt: float, qr_height_pt: float, margin_pt: float = 24.0) -> fitz.Rect:
    """Return a rectangle to place the QR at bottom-right with margin."""
    x1 = page_rect.width - margin_pt - qr_width_pt
    y1 = page_rect.height - margin_pt - qr_height_pt
    x2 = page_rect.width - margin_pt
    y2 = page_rect.height - margin_pt
    return fitz.Rect(x1, y1, x2, y2)


def _overlay_qr_on_pdf(input_pdf: Path, output_pdf: Path, qr_png_path: Path, qr_size_pt: float = 96.0) -> None:
    """Overlay the QR PNG on each page of the PDF and save as output_pdf.

    qr_size_pt is in PDF points (1/72 inch). 96pt ~= 1.33in square.
    """
    try:
        with fitz.open(str(input_pdf)) as document:
            for page in document:
                rect = _calculate_qr_rect(page.rect, qr_size_pt, qr_size_pt)
                page.insert_image(rect, filename=str(qr_png_path), overlay=True, keep_proportion=True)
                label_margin = 6.0
                label_height = 12.0
                label_rect = fitz.Rect(
                    rect.x0,
                    rect.y1 + label_margin,
                    rect.x1,
                    rect.y1 + label_margin + label_height
                )
                if label_rect.y1 <= page.rect.height:
                    page.insert_textbox(
                        label_rect,
                        "To Verify",
                        fontsize=10,
                        fontname="helv",
                        align=fitz.TEXT_ALIGN_CENTER
                    )
            document.save(str(output_pdf))
    finally:
        try:
            qr_png_path.unlink(missing_ok=True)  # type: ignore[arg-type]
        except Exception:
            pass


@app.post("/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)) -> JSONResponse:
    """Accept a PDF upload, stamp it with a QR encoding 'التقرير كامل', and return URL."""
    if file.content_type not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=400, detail="Content-Type must be application/pdf")

    saved_path = _save_upload_to_disk(file)

    # Arabic content to encode in QR
    qr_text = "التقرير كامل"
    qr_png = _generate_qr_png(qr_text, scale=6, border=2)

    output_filename = f"{saved_path.stem}_stamped.pdf"
    output_path = OUTPUT_DIR / output_filename

    _overlay_qr_on_pdf(saved_path, output_path, qr_png, qr_size_pt=110.0)

    return JSONResponse({
        "message": "تم رفع الملف وختمه بالباركود",
        "download_url": f"/files/{output_filename}",
        "filename": output_filename,
    })


@app.get("/")
async def index() -> HTMLResponse:
    """Simple HTML form to upload a PDF and get back the stamped file link."""
    html = """
    <!doctype html>
    <html lang=\"ar\" dir=\"rtl\">
    <head>
        <meta charset=\"utf-8\" />
        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
        <title>رفع التقرير وختمه بباركود</title>
        <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Tahoma, Arial; margin: 2rem; }
            .card { max-width: 640px; margin: 0 auto; padding: 1.5rem; border: 1px solid #ddd; border-radius: 12px; }
            .row { margin-bottom: 1rem; }
            button { padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid #999; cursor: pointer; }
            .link { margin-top: 1rem; }
        </style>
    </head>
    <body>
        <div class=\"card\">
            <h2>رفع PDF وختمه بعبارة "التقرير كامل"</h2>
            <div class=\"row\">
                <input id=\"file\" type=\"file\" accept=\"application/pdf\" />
            </div>
            <div class=\"row\">
                <button id=\"uploadBtn\">رفع ومعالجة</button>
            </div>
            <div id=\"result\" class=\"link\"></div>
        </div>
        <script>
        const btn = document.getElementById('uploadBtn');
        const fileInput = document.getElementById('file');
        const result = document.getElementById('result');
        btn.addEventListener('click', async () => {
            result.textContent = 'جارٍ الرفع والمعالجة...';
            const file = fileInput.files[0];
            if (!file) { result.textContent = 'الرجاء اختيار ملف PDF'; return; }
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await fetch('/upload-pdf', { method: 'POST', body: formData });
                if (!res.ok) { throw new Error('فشل الرفع'); }
                const data = await res.json();
                result.innerHTML = `تمت المعالجة: <a href="${data.download_url}" target="_blank">تحميل الملف المختوم</a>`;
            } catch (e) {
                result.textContent = 'حدث خطأ أثناء الرفع أو المعالجة';
            }
        });
        </script>
    </body>
    </html>
    """
    return HTMLResponse(html)


@app.get("/healthz")
async def health() -> dict:
    return {"status": "ok"}
