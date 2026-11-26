"""Builds bin/libVkLayer_dlt.so (the Vulkan capture layer) for Linux x86_64 with the zig compiler (pip install ziglang).
Downloads the Vulkan headers the first time (not committed)."""
import os, subprocess, sys, urllib.request, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
version = '1.4.328'
cache = os.path.join(root, '.cache')
headers = os.path.join(cache, 'Vulkan-Headers-%s' % version, 'include')
if not os.path.isdir(headers):
    os.makedirs(cache, exist_ok=True)
    zpath = os.path.join(cache, 'vkh.zip')
    urllib.request.urlretrieve('https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v%s.zip' % version, zpath)
    zipfile.ZipFile(zpath).extractall(cache)
out = os.path.join(root, 'bin', 'libVkLayer_dlt.so')
cmd = [sys.executable, '-m', 'ziglang', 'cc', '-target', 'x86_64-linux-gnu.2.28', '-shared', '-fPIC', '-O2', '-std=gnu11', '-Wall', '-Wextra',
       '-Wno-unused-parameter', '-fvisibility=hidden', '-I', headers, os.path.join(root, 'layer', 'dlt_layer.c'), '-o', out, '-lpthread']
subprocess.check_call(cmd)
print(out, os.path.getsize(out))
