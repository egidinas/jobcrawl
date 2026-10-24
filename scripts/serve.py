#!/usr/bin/env python3
"""Static server for the web app (web/): the app at /, a data folder at /data/, optionally a models folder at /models/.

    python scripts/serve.py --data DIR [--models DIR] [--port 8000] [--host 127.0.0.1]

--data is the folder `jobcrawl publish` wrote (config.json, jobs-*.json, match/); the app reads it through ?data=/data/ or the default.
--models is the folder that holds eg2/ (scripts/fetch_model.py writes models/eg2/); the app reads config.json's model_url (default models/eg2/).
--port 0 picks a free port; the chosen address is printed on the first line. Standard library only. No directory listings.
"""
import argparse
import functools
import http.server
import os
import posixpath
import socketserver
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', 'web'))

# the types the app needs, on top of the defaults of the http.server module
MIME = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.onnx': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.css': 'text/css',
    '.html': 'text/html',
    '.txt': 'text/plain',
    '.svg': 'image/svg+xml',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **MIME)
    roots = {}       # set by make_handler: {'data': DIR, 'models': DIR or None}

    def translate_path(self, path):
        path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        parts = [p for p in posixpath.normpath(path).split('/') if p and p not in ('.', '..')]
        root = WEB
        if parts and parts[0] == 'data':
            root, parts = self.roots['data'], parts[1:]
        elif parts and parts[0] == 'models' and self.roots.get('models'):
            root, parts = self.roots['models'], parts[1:]
        return os.path.join(root, *parts)

    def list_directory(self, path):
        self.send_error(404, 'not found')
        return None

    def log_message(self, fmt, *args):
        pass


def make_handler(data, models):
    return type('AppHandler', (Handler,), {'roots': {'data': data, 'models': models}})


def main(argv=None):
    ap = argparse.ArgumentParser(description='Serve the jobcrawl web app with a data folder (and optionally a models folder).')
    ap.add_argument('--data', required=True, metavar='DIR', help='data folder written by jobcrawl publish')
    ap.add_argument('--models', metavar='DIR', help='folder that holds eg2/ (from scripts/fetch_model.py), served at /models/')
    ap.add_argument('--port', type=int, default=8000, help='port (default 8000; 0 picks a free one)')
    ap.add_argument('--host', default='127.0.0.1', help='address to bind (default 127.0.0.1)')
    args = ap.parse_args(argv)
    data = os.path.abspath(args.data)
    if not os.path.isdir(data):
        print(f'serve.py: data folder not found: {data}', file=sys.stderr)
        return 2
    models = os.path.abspath(args.models) if args.models else None
    if models and not os.path.isdir(models):
        print(f'serve.py: models folder not found: {models}', file=sys.stderr)
        return 2
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer((args.host, args.port), make_handler(data, models))
    host, port = server.server_address[:2]
    print(f'serving http://{host}:{port}/ (app), /data/ = {data}' + (f', /models/ = {models}' if models else ''), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
