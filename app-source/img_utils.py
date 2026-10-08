import sys, os
from PIL import Image, ImageOps, JpegImagePlugin  # noqa: F401 - registers JPEG encoder for PDF export

def images_to_pdf(input_files, output_path):
    images = []
    for f in input_files:
        img = Image.open(f)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        else:
            img = img.copy()
        images.append(img)

    if images:
        images[0].save(output_path, save_all=True, append_images=images[1:] if len(images) > 1 else [])
    return output_path

def compress_image(input_file, output_path, quality=80):
    img = Image.open(input_file)
    if img.mode == 'RGBA':
        img = img.convert('RGB')
    img.save(output_path, quality=quality, optimize=True)
    return output_path

def convert_image(input_file, output_path, fmt='PNG'):
    img = Image.open(input_file)
    if fmt.upper() in ('JPG', 'JPEG') and img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')
    img.save(output_path, format=fmt.upper())
    return output_path

def resize_image(input_file, output_path, width=None, height=None):
    img = Image.open(input_file)
    orig_w, orig_h = img.size
    if width and height:
        new_w, new_h = width, height
    elif width:
        ratio = width / orig_w
        new_w, new_h = width, int(orig_h * ratio)
    elif height:
        ratio = height / orig_h
        new_w, new_h = int(orig_w * ratio), height
    else:
        new_w, new_h = orig_w // 2, orig_h // 2
    img_resized = img.resize((new_w, new_h), Image.LANCZOS)
    img_resized.save(output_path)
    return output_path

def grayscale_image(input_file, output_path):
    img = Image.open(input_file)
    gray = ImageOps.grayscale(img)
    gray.save(output_path)
    return output_path

if __name__ == '__main__':
    action = sys.argv[1]
    try:
        if action == 'to-pdf':
            files = sys.argv[2].split('|')
            out = sys.argv[3]
            result = images_to_pdf(files, out)
            print(f"OK:{result}")
        elif action == 'compress':
            f = sys.argv[2]
            out = sys.argv[3]
            quality = int(sys.argv[4]) if len(sys.argv) > 4 else 80
            result = compress_image(f, out, quality)
            print(f"OK:{result}")
        elif action == 'convert':
            f = sys.argv[2]
            out = sys.argv[3]
            fmt = sys.argv[4] if len(sys.argv) > 4 else 'PNG'
            result = convert_image(f, out, fmt)
            print(f"OK:{result}")
        elif action == 'resize':
            f = sys.argv[2]
            out = sys.argv[3]
            w = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != '' else None
            h = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != '' else None
            result = resize_image(f, out, w, h)
            print(f"OK:{result}")
        elif action == 'grayscale':
            f = sys.argv[2]
            out = sys.argv[3]
            result = grayscale_image(f, out)
            print(f"OK:{result}")
        else:
            print(f"ERR:Unknown action: {action}")
    except Exception as e:
        print(f"ERR:{e}")
