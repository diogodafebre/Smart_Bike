Import("env")
import os
import shutil
import gzip

def prepare_filesystem(*args, **kwargs):
    """
    Script that:
    1. Copies all files from dashboard/ to data/
    2. Compresses .js files in data/libs/ 
    3. Keeps only .gz files in data/libs/ (removes uncompressed .js)
    
    This allows development in dashboard/ folder while uploading compressed
    files to ESP32 SPIFFS.
    """
    project_dir = env.get("PROJECT_DIR")
    dashboard_dir = os.path.join(project_dir, "dashboard")
    data_dir = os.path.join(project_dir, "data")
    libs_dir = os.path.join(data_dir, "libs")
    
    print("\n[SMART BIKE] Preparing filesystem for ESP32 upload...")
    print(f"  Source: dashboard/")
    print(f"  Destination: data/")
    
    # Step 1: Copy everything from dashboard/ to data/
    print("\n[Step 1] Copying dashboard files...")
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    shutil.copytree(dashboard_dir, data_dir)
    print(f"  ✓ Dashboard copied to data/")
    
    # Step 2: Compress .js files in data/libs/ and remove originals
    if os.path.isdir(libs_dir):
        print("\n[Step 2] Compressing library files...")
        for filename in os.listdir(libs_dir):
            if filename.endswith(".js"):
                src_file = os.path.join(libs_dir, filename)
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
                    
                    # Remove original .js file
                    os.remove(src_file)
                    
                    print(f"  ✓ {filename}")
                    print(f"    {before_size} → {after_size} bytes ({ratio}% smaller)")
                    
                except Exception as e:
                    print(f"  ✗ Error compressing {filename}: {e}")
    else:
        print("\n[Step 2] No libs/ directory found - skipping compression")
    
    # Step 3: Configure PlatformIO to use data/ folder
    env.Replace(PROJECTDATA_DIR=data_dir)
    
    print(f"\n[SMART BIKE] Filesystem ready for upload!")
    print(f"  Dashboard files copied: data/")
    print(f"  Libraries compressed: data/libs/*.gz")
    print(f"  PlatformIO will upload: data/\n")

# Hook into the filesystem build process
env.AddPreAction("$BUILD_DIR/spiffs.bin", prepare_filesystem)
# Also hook into the uploadfs target to ensure data/ is created before upload
env.AddPreAction("uploadfs", prepare_filesystem)

