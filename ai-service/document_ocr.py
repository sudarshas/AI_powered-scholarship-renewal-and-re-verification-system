import io
import os
import subprocess
import time

import pymupdf
import pytesseract
from PIL import Image
from pytesseract import Output

OCR_LANGUAGE = os.environ.get("OCR_LANGUAGE", "eng")
OCR_TIMEOUT_SECONDS = int(os.environ.get("OCR_TIMEOUT_SECONDS", "45"))
MAX_OCR_PAGES = int(os.environ.get("MAX_OCR_PAGES", "10"))
MAX_EXTRACTED_CHARACTERS = 50000
TESSERACT_CMD = os.environ.get("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
elif os.name == "nt":
    for candidate in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ):
        if os.path.isfile(candidate):
            pytesseract.pytesseract.tesseract_cmd = candidate
            break


def runtime_status():
    try:
        version = str(pytesseract.get_tesseract_version())
        languages = pytesseract.get_languages(config="")
        return {
            "available": OCR_LANGUAGE in languages,
            "engine": "Tesseract",
            "version": version,
            "language": OCR_LANGUAGE,
            "language_available": OCR_LANGUAGE in languages,
            "message": None if OCR_LANGUAGE in languages else f"Tesseract language data '{OCR_LANGUAGE}' is not installed",
        }
    except (pytesseract.TesseractNotFoundError, OSError, subprocess.CalledProcessError) as error:
        return {
            "available": False,
            "engine": "Tesseract",
            "version": None,
            "language": OCR_LANGUAGE,
            "language_available": False,
            "message": "Tesseract is not installed or cannot be found. Install it and restart FastAPI.",
        }


def _ocr_image(image, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("OCR time limit exceeded")
    data = pytesseract.image_to_data(
        image,
        lang=OCR_LANGUAGE,
        config="--oem 3 --psm 6",
        output_type=Output.DICT,
        timeout=max(1, remaining),
    )
    lines = {}
    confidences = []
    for index, value in enumerate(data["text"]):
        token = value.strip()
        if not token:
            continue
        key = (
            data["page_num"][index],
            data["block_num"][index],
            data["par_num"][index],
            data["line_num"][index],
        )
        lines.setdefault(key, []).append(token)
        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            continue
        if confidence >= 0:
            confidences.append(confidence)
    text = "\n".join(" ".join(words) for words in lines.values())
    confidence = round(sum(confidences) / len(confidences), 2) if confidences else None
    return text, confidence


def _result(status, text="", method=None, confidence=None, error=None):
    clipped = text[:MAX_EXTRACTED_CHARACTERS]
    if len(text) > MAX_EXTRACTED_CHARACTERS:
        clipped += "\n[OCR text truncated]"
    return {
        "ocr_status": status,
        "ocr_text": clipped,
        "ocr_method": method,
        "ocr_confidence": confidence,
        "ocr_error": error,
    }


def extract_document_text(content, content_type):
    engine = runtime_status()
    deadline = time.monotonic() + OCR_TIMEOUT_SECONDS
    try:
        if content_type == "application/pdf":
            with pymupdf.open(stream=content, filetype="pdf") as document:
                if document.page_count > MAX_OCR_PAGES:
                    return _result(
                        "limit_exceeded",
                        error=f"OCR is limited to {MAX_OCR_PAGES} pages per document.",
                    )
                page_text = []
                confidences = []
                methods = set()
                for page in document:
                    embedded_text = page.get_text().strip()
                    if len(embedded_text) >= 12:
                        page_text.append(embedded_text)
                        methods.add("embedded_pdf_text")
                        continue
                    if not engine["available"]:
                        return _result("unavailable", error=engine["message"])
                    if max(page.rect.width, page.rect.height) > 1800:
                        return _result("limit_exceeded", error="PDF page dimensions exceed the OCR processing limit.")
                    pixmap = page.get_pixmap(dpi=180, colorspace=pymupdf.csGRAY, alpha=False)
                    image = Image.open(io.BytesIO(pixmap.tobytes("png")))
                    text, confidence = _ocr_image(image, deadline)
                    page_text.append(text)
                    methods.add("tesseract")
                    if confidence is not None:
                        confidences.append(confidence)
                combined = "\n\n".join(page_text).strip()
                if not combined:
                    return _result("no_text", method="tesseract" if methods else "embedded_pdf_text")
                confidence = round(sum(confidences) / len(confidences), 2) if confidences else None
                method = "mixed" if len(methods) > 1 else next(iter(methods), "embedded_pdf_text")
                return _result("complete", combined, method, confidence)

        if not engine["available"]:
            return _result("unavailable", error=engine["message"])
        with Image.open(io.BytesIO(content)) as source:
            if source.width * source.height > 25000000:
                return _result("limit_exceeded", error="Image dimensions exceed the OCR processing limit.")
            source.load()
            image = source.convert("RGB")
        text, confidence = _ocr_image(image, deadline)
        if not text.strip():
            return _result("no_text", method="tesseract", confidence=confidence)
        return _result("complete", text, "tesseract", confidence)
    except (pymupdf.FileDataError, pymupdf.EmptyFileError, OSError, ValueError) as error:
        return _result("failed", error=f"Document could not be read for OCR: {error.__class__.__name__}")
    except (pytesseract.TesseractNotFoundError, pytesseract.TesseractError, RuntimeError, TimeoutError) as error:
        return _result("failed", error=f"OCR processing failed: {error.__class__.__name__}")
