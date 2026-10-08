import sys, os, json
from pypdf import PdfReader, PdfWriter

def unique_path(path):
    if not os.path.exists(path):
        return path
    folder = os.path.dirname(path)
    base, ext = os.path.splitext(os.path.basename(path))
    index = 1
    candidate = os.path.join(folder, f"{base}_{index}{ext}")
    while os.path.exists(candidate):
        index += 1
        candidate = os.path.join(folder, f"{base}_{index}{ext}")
    return candidate

def merge_pdfs(input_files, output_path):
    writer = PdfWriter()
    for f in input_files:
        reader = PdfReader(f)
        for page in reader.pages:
            writer.add_page(page)
    with open(output_path, 'wb') as out:
        writer.write(out)
    return output_path

def split_pdf(input_file, output_dir, mode='all'):
    reader = PdfReader(input_file)
    name = os.path.splitext(os.path.basename(input_file))[0]
    total = len(reader.pages)
    results = []

    if mode == 'all':
        for i, page in enumerate(reader.pages):
            writer = PdfWriter()
            writer.add_page(page)
            out_path = unique_path(os.path.join(output_dir, f"{name}_page{i+1}.pdf"))
            with open(out_path, 'wb') as out:
                writer.write(out)
            results.append(out_path)
    elif mode == 'range':
        mid = total // 2
        for part, (start, end) in enumerate([(0, mid), (mid, total)], 1):
            writer = PdfWriter()
            for i in range(start, end):
                writer.add_page(reader.pages[i])
            out_path = unique_path(os.path.join(output_dir, f"{name}_part{part}.pdf"))
            with open(out_path, 'wb') as out:
                writer.write(out)
            results.append(out_path)
    return results

def add_watermark(input_file, output_path, text):
    reader = PdfReader(input_file)
    writer = PdfWriter()

    for page in reader.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)

        overlay = PdfWriter()
        from pypdf import PageObject
        new_page = PageObject.create_blank_page(width=width, height=height)

        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        packet = io.BytesIO()
        c = canvas.Canvas(packet, pagesize=(width, height))
        c.setFont("Helvetica", 40)
        c.setFillColorRGB(0.8, 0.8, 0.8)
        c.setFillAlpha(0.3)
        c.saveState()
        c.translate(width/2, height/2)
        c.rotate(45)
        c.drawCentredString(0, 0, text)
        c.restoreState()
        c.save()
        packet.seek(0)

        wm_reader = PdfReader(packet)
        if wm_reader.pages:
            page.merge_page(wm_reader.pages[0])
        writer.add_page(page)

    with open(output_path, 'wb') as out:
        writer.write(out)
    return output_path

def render_pdf_pages(input_file, output_dir, scale=2):
    import fitz

    os.makedirs(output_dir, exist_ok=True)
    name = os.path.splitext(os.path.basename(input_file))[0]
    results = []
    doc = fitz.open(input_file)
    try:
        matrix = fitz.Matrix(float(scale), float(scale))
        for i, page in enumerate(doc, 1):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            out_path = unique_path(os.path.join(output_dir, f"{name}_page{i}.png"))
            pix.save(out_path)
            results.append(out_path)
    finally:
        doc.close()
    return results

def compress_pdf(input_file, output_path):
    reader = PdfReader(input_file)
    writer = PdfWriter()

    for page in reader.pages:
        try:
            page.compress_content_streams()
        except Exception:
            pass
        writer.add_page(page)

    if reader.metadata:
        writer.add_metadata(reader.metadata)

    with open(output_path, 'wb') as out:
        writer.write(out)
    return output_path

def rotate_pdf(input_file, output_path, degrees=90):
    reader = PdfReader(input_file)
    writer = PdfWriter()
    degrees = int(degrees)

    for page in reader.pages:
        try:
            page.rotate(degrees)
        except AttributeError:
            page.rotate_clockwise(degrees)
        writer.add_page(page)

    with open(output_path, 'wb') as out:
        writer.write(out)
    return output_path

if __name__ == '__main__':
    action = sys.argv[1]
    try:
        if action == 'merge':
            files = sys.argv[2].split('|')
            out = sys.argv[3]
            result = merge_pdfs(files, out)
            print(f"OK:{result}")
        elif action == 'split':
            f = sys.argv[2]
            out_dir = sys.argv[3]
            mode = sys.argv[4] if len(sys.argv) > 4 else 'all'
            results = split_pdf(f, out_dir, mode)
            print(f"OK:{'|'.join(results)}")
        elif action == 'watermark':
            f = sys.argv[2]
            out = sys.argv[3]
            text = sys.argv[4]
            result = add_watermark(f, out, text)
            print(f"OK:{result}")
        elif action == 'render':
            f = sys.argv[2]
            out_dir = sys.argv[3]
            scale = float(sys.argv[4]) if len(sys.argv) > 4 else 2
            results = render_pdf_pages(f, out_dir, scale)
            print(f"OK:{'|'.join(results)}")
        elif action == 'compress':
            f = sys.argv[2]
            out = sys.argv[3]
            result = compress_pdf(f, out)
            print(f"OK:{result}")
        elif action == 'rotate':
            f = sys.argv[2]
            out = sys.argv[3]
            degrees = sys.argv[4] if len(sys.argv) > 4 else 90
            result = rotate_pdf(f, out, degrees)
            print(f"OK:{result}")
        else:
            print(f"ERR:Unknown action: {action}")
    except Exception as e:
        print(f"ERR:{e}")
