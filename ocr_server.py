from flask import Flask, request, jsonify
from paddleocr import PaddleOCR
from pdf2image import convert_from_path
import os, uuid

app = Flask(__name__)
ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)

POPPLER_BIN = r"C:\poppler-25.12.0\Library\bin"  # <-- set this

def ocr_one_image(path: str) -> str:
    result = ocr.ocr(path)
    if not result or not result[0]:
        return ""
    return "\n".join([line[1][0] for line in result[0]])

@app.route("/ocr", methods=["POST"])
def run_ocr():
    f = request.files.get("file") or request.files.get("image")
    if not f:
        return jsonify({"error": "No file uploaded (expected 'file' or 'image')"}), 400

    # Prefer mimetype; filename can be empty from some clients
    mimetype = (f.mimetype or "").lower()
    orig_ext = (os.path.splitext(f.filename)[1] or "").lower()

    # Decide extension safely
    if mimetype == "application/pdf" or orig_ext == ".pdf":
        ext = ".pdf"
    else:
        # default to .jpg for images if extension missing
        ext = orig_ext if orig_ext else ".jpg"

    os.makedirs("tmp", exist_ok=True)
    base = str(uuid.uuid4())
    in_path = os.path.join("tmp", base + ext)
    f.save(in_path)
    print(f"Saved uploaded file to {in_path} (mimetype={mimetype}), orig_ext={orig_ext}")
    try:
        if ext == ".pdf":
            pages = convert_from_path(in_path, dpi=250, poppler_path=POPPLER_BIN)
            if not pages:
                return jsonify({"error": "PDF convert returned 0 pages"}), 500

            parts = []
            for i, page in enumerate(pages[:5]):
                img_path = os.path.join("tmp", f"{base}_{i}.png")
                page.save(img_path, "PNG")
                t = ocr_one_image(img_path)
                if t:
                    parts.append(t)
                os.remove(img_path)
            return jsonify({"text": "\n\n".join(parts)})

        # Image file
        return jsonify({"text": ocr_one_image(in_path)})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        if os.path.exists(in_path):
            os.remove(in_path)

if __name__ == "__main__":
    app.run(port=5001)