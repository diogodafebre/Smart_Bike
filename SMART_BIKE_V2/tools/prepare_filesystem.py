Import("env")
import os
import shutil
import gzip

def prepare_filesystem(*args, **kwargs):
    """
    Script that:
    1. Copies all files from dashboard/ to data/
    2. Compresses .html, .css, .js files throughout data/
    3. Keeps only .gz files (removes uncompressed originals)
    
    This allows development in dashboard/ folder while uploading compressed
    files to ESP32 SPIFFS for faster page loads.
    """
    project_dir = env.get("PROJECT_DIR")
    dashboard_dir = os.path.join(project_dir, "dashboard")
    data_dir = os.path.join(project_dir, "data")
    
    print("\n[SMART BIKE] Preparing filesystem for ESP32 upload...")
    print(f"  Source: dashboard/")
    print(f"  Destination: data/")
    
    # Step 1: Copy everything from dashboard/ to data/
    print("\n[Step 1] Copying dashboard files...")
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    shutil.copytree(dashboard_dir, data_dir)
    print(f"  ✓ Dashboard copied to data/")

    # Remove models directory from prepared data (keep it only in dashboard/)
    models_dir = os.path.join(data_dir, "models")
    if os.path.isdir(models_dir):
        shutil.rmtree(models_dir)
        print("  ✓ Removed data/models (not uploaded)")
    
    # Step 2: Compress compressible files (.html, .css, .js) throughout data/
    print("\n[Step 2] Compressing web files...")
    
    compressed_count = 0
    total_before = 0
    total_after = 0
    
    # Extensions to compress
    compressible_extensions = ('.html', '.css', '.js', '.wasm')
    
    # Walk through all files in data/ directory
    for root, dirs, files in os.walk(data_dir):
        # Skip images directory (binary files like PNG/JPG don't compress well)
        if 'images' in dirs:
            dirs.remove('images')
        
        for filename in files:
            if filename.endswith(compressible_extensions):
                src_file = os.path.join(root, filename)
                gz_file = src_file + ".gz"
                
                # Get file sizes for reporting
                before_size = os.path.getsize(src_file)
                
                # Compress with gzip
                try:
                    with open(src_file, 'rb') as f_in:
                        with gzip.open(gz_file, 'wb', compresslevel=9) as f_out:
                            shutil.copyfileobj(f_in, f_out)
                    
                    after_size = os.path.getsize(gz_file)
                    ratio = round((1 - after_size / before_size) * 100, 1)
                    
                    # Remove original file
                    os.remove(src_file)
                    
                    # Display relative path for clarity
                    rel_path = os.path.relpath(src_file, data_dir)
                    print(f"  ✓ {rel_path}")
                    print(f"    {before_size:,} → {after_size:,} bytes ({ratio}% smaller)")
                    
                    compressed_count += 1
                    total_before += before_size
                    total_after += after_size
                    
                except Exception as e:
                    print(f"  ✗ Error compressing {filename}: {e}")
    
    if compressed_count > 0:
        overall_ratio = round((1 - total_after / total_before) * 100, 1)
        print(f"\n  Summary: {compressed_count} files compressed")
        print(f"  Total: {total_before:,} → {total_after:,} bytes ({overall_ratio}% reduction)")
    else:
        print("  No compressible files found")
    
    # Step 3: Configure PlatformIO to use data/ folder
    env.Replace(PROJECTDATA_DIR=data_dir)
    
    print(f"\n[SMART BIKE] Filesystem ready for upload!")
    print(f"  All .html, .css, .js files compressed with gzip")
    print(f"  PlatformIO will upload: data/\n")

# Hook into the filesystem build process
env.AddPreAction("$BUILD_DIR/spiffs.bin", prepare_filesystem)
# Hook into buildfs target (when running: pio run -t buildfs)
env.AddPreAction("buildfs", prepare_filesystem)
# Also hook into the uploadfs target to ensure data/ is created before upload
env.AddPreAction("uploadfs", prepare_filesystem)

