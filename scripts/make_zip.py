"""Builds out/Live-Translator-v<version>.zip for Decky's "install from ZIP" (run `pnpm run build` first)."""
import json, os, subprocess, sys, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
version = json.load(open(os.path.join(root, 'package.json')))['version']
top = 'Live-Translator'
import glob
# the Python files must at least be free of undefined names (a missing import killed the backend once)
if subprocess.call([sys.executable, "-m", "pyflakes", "main.py", "bin/dlt_capture.py", "bin/dlt_retention.py"]) != 0:
    sys.exit("pyflakes found problems")
# ... and the TypeScript of the panel must have no undefined names (a block lost in an edit once crashed the Steam UI): errors in node_modules (types of Decky) are not ours
check = subprocess.run("npx tsc --noEmit -p .", shell=True, capture_output=True, text=True)
ours = [line for line in (check.stdout + check.stderr).splitlines() if "error TS" in line and "node_modules" not in line]
if ours:
    sys.exit("tsc found problems: " + " | ".join(ours[:10]))
# ... and no function or constant of the panel may disappear unnoticed: the names of the last commit must all still be there (ALLOW_REMOVED=name,name to say it is meant)
import re
try:
    before = subprocess.run(["git", "show", "HEAD:src/index.tsx"], capture_output=True, text=True, check=True).stdout
    names = lambda text: {a or b for a, b in re.findall(r"^(?:async )?function (\w+)|^(?:const|let) (\w+)", text, re.M)}
    gone = names(before) - names(open("src/index.tsx", encoding="utf-8").read()) - set(filter(None, os.environ.get("ALLOW_REMOVED", "").split(",")))
    if gone:
        sys.exit("these names of src/index.tsx are gone since the last commit: " + ", ".join(sorted(gone)) + " (ALLOW_REMOVED=... if meant)")
except subprocess.CalledProcessError:
    pass
files = ['dist/index.js', 'assets/engine-worker.js', 'assets/scout/worker.js', 'package.json', 'plugin.json', 'main.py', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'bin/dlt_capture.py', 'bin/dlt_retention.py', 'bin/libVkLayer_dlt.so', 'assets/models-registry.json', 'assets/bergamot/translator-worker.js', 'assets/bergamot/bergamot-translator-worker.js', 'assets/bergamot/bergamot-translator-worker.wasm', 'assets/bergamot/README.md', 'assets/ocr/det.onnx', 'assets/ocr/rec.onnx', 'assets/ocr/keys.txt', 'assets/ocr/words-en.txt', 'assets/ocr/README.md', 'assets/ort/ort.wasm.min.js', 'assets/ort/ort-wasm-simd-threaded.mjs', 'assets/ort/ort-wasm-simd-threaded.wasm', 'assets/ort/README.md'] + [f.replace(os.sep, '/')[len(root) + 1:] for f in glob.glob(os.path.join(root, 'assets', 'tesseract', '**', '*'), recursive=True) if os.path.isfile(f)]
os.makedirs(os.path.join(root, 'out'), exist_ok=True)
out = os.path.join(root, 'out', 'Live-Translator-v%s.zip' % version)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo('%s/%s' % (top, f))
        info.external_attr = (0o755 if f.startswith('bin/') else 0o644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, open(os.path.join(root, f), 'rb').read())
print(out)
