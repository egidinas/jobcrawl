#!/usr/bin/env python3
"""Downloads EmbeddingGemma 2 (q4 ONNX) and its tokenizer, then splits it for the browser. Run once, offline files stay on disk.

    python3 scripts/fetch_model.py                           # onnx-community/embeddinggemma-2-ONNX into models/eg2/
    python3 scripts/fetch_model.py --profile profiles/aerospace
    python3 scripts/fetch_model.py --dir models/eg2 --no-split

The repository comes from the profile's embed.model_repo (default onnx-community/embeddinggemma-2-ONNX). The model is licensed under the
Gemma Terms of Use: it is downloaded, never committed (models/ is in .gitignore; see NOTICE.md).
Downloads resume from a partial file (HTTP Range) when the server allows it. Standard library only; the split needs onnx
(requirements-embed.txt) and the check needs onnxruntime and tokenizers.
"""
import argparse
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
DEFAULT_REPO = 'onnx-community/embeddinggemma-2-ONNX'
FILES = ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data', 'tokenizer.json', 'tokenizer_config.json']  # the browser tokenizer needs the config too
CHUNK = 1 << 20


def repo_of(profile_dir):
    if not profile_dir:
        return DEFAULT_REPO
    from jobcrawl.profile import load_profile
    return load_profile(profile_dir)['embed']['model_repo']


def download(url, dst, log=print):
    """Fetches url into dst. A partial file (dst + '.part') is continued when the server accepts a Range request."""
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        log(f'  {os.path.basename(dst)} is there ({os.path.getsize(dst) / 1e6:.1f} MB), skipped')
        return
    os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
    part = dst + '.part'
    start = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {'User-Agent': 'jobcrawl-fetch-model/0.1'}
    if start:
        headers['Range'] = f'bytes={start}-'
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        if e.code == 416 and start:                       # the partial file is already complete
            os.replace(part, dst); return
        raise
    with resp:
        if start and resp.status != 206:                  # the server ignored the Range: start again
            start = 0
        mode = 'ab' if start else 'wb'
        log(f'  downloading {os.path.basename(dst)} ...' + (f' (continuing at {start / 1e6:.1f} MB)' if start else ''))
        with open(part, mode) as fh:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
    os.replace(part, dst)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Download and split EmbeddingGemma 2 (q4) for jobcrawl.')
    ap.add_argument('--profile', help='profile folder: its embed.model_repo is used')
    ap.add_argument('--repo', help='Hugging Face repository (overrides the profile)')
    ap.add_argument('--dir', default=os.path.join(ROOT, 'models', 'eg2'), help='where the model goes (default models/eg2)')
    ap.add_argument('--no-split', action='store_true', help='download only')
    ap.add_argument('--skip-check', action='store_true', help='split without comparing against the original model')
    a = ap.parse_args(argv)
    repo = a.repo or repo_of(a.profile)
    base = f'https://huggingface.co/{repo}/resolve/main/'
    print(f'model: {repo} -> {a.dir}')
    try:
        for f in FILES:
            download(base + f, os.path.join(a.dir, f))
    except (OSError, urllib.error.URLError) as e:
        print(f'fetch_model: download failed: {e}. Run again to continue.', file=sys.stderr)
        return 1
    if a.no_split:
        return 0
    from jobcrawl.model.split import split
    split(a.dir, a.dir, check=not a.skip_check)
    print(f'done: {a.dir} (embed with: jobcrawl embed --site SITE --model-dir {os.path.relpath(a.dir)})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
