import os
import gzip
import shutil

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
LIBS_DIR = os.path.join(DATA_DIR, 'libs')

# File extensions we will gzip; images like png/jpg don't benefit much
GZIP_EXTS = {'.html', '.htm', '.css', '.js', '.json', '.svg'}

def should_gzip(path: str) -> bool:
    if path.endswith('.gz'):
        return False
    _, ext = os.path.splitext(path)
    return ext.lower() in GZIP_EXTS

def compress_file(src: str) -> str:
    dst = src + '.gz'
    with open(src, 'rb') as f_in, gzip.open(dst, 'wb', compresslevel=9) as f_out:
        shutil.copyfileobj(f_in, f_out)
    # Replace original with gz to save SPIFFS space
    try:
        os.remove(src)
    except OSError:
        pass
    return dst

def main():
    if not os.path.isdir(DATA_DIR):
        print(f"No data directory found at {DATA_DIR}")
        return
    if not os.path.isdir(LIBS_DIR):
        print(f"No libs directory found at {LIBS_DIR}. Nothing to do.")
        return
    total_before = 0
    total_after = 0
    converted = 0
    # Only compress within data/libs (leave index.html, images, etc. untouched)
    for root, _, files in os.walk(LIBS_DIR):
        for name in files:
            src = os.path.join(root, name)
            if should_gzip(src):
                before = os.path.getsize(src)
                dst = compress_file(src)
                after = os.path.getsize(dst)
                total_before += before
                total_after += after
                converted += 1
                print(f"gzipped: {os.path.relpath(src, DATA_DIR)} -> {os.path.relpath(dst, DATA_DIR)} ({before} -> {after} bytes)")
            else:
                total_after += os.path.getsize(src)
    if converted:
        print(f"Done. Converted {converted} files in /data/libs. Size before ~{total_before} bytes, after ~{total_after} bytes.")
    else:
        print("No files converted under /data/libs. Ensure assets have extensions in: " + ", ".join(sorted(GZIP_EXTS)))

if __name__ == '__main__':
    main()
