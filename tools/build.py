"""Build four installable source bundles with a pinned optional relay binary."""
import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.5.0-rc.2'
PIN = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'
VENDOR_URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe'

def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def build(output, cloudflared=None):
    output.mkdir(parents=True, exist_ok=True)
    binary = Path(cloudflared) if cloudflared else ROOT / 'vendor/cloudflared.exe'
    if not binary.exists():
        binary.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(VENDOR_URL, binary)
    if sha(binary) != PIN:
        raise ValueError('cloudflared SHA-256 mismatch')
    archives = []
    for platform, label in [('windows', 'Windows'), ('mac', 'macOS')]:
        for mode, edition in [('single', 'Single'), ('sync', 'Sync')]:
            name = f'CodexUsageDashboard-{VERSION}-{edition}-{label}'
            with tempfile.TemporaryDirectory(prefix='usage-build-') as temporary:
                app = Path(temporary) / name
                shutil.copytree(ROOT / 'apps' / platform, app)
                (app / 'edition.json').write_text(json.dumps({'version': VERSION, 'mode': mode}) + '\n', encoding='utf-8')
                shutil.copy2(ROOT / 'README.md', app / 'README.md')
                shutil.copy2(ROOT / 'NOTICE.md', app / 'NOTICE.md')
                for doc in (ROOT / 'docs').glob('*.md'):
                    shutil.copy2(doc, app / 'docs' / doc.name)
                if mode == 'sync' and platform == 'windows':
                    shutil.copy2(binary, app / 'tools/cloudflared.exe')
                if mode == 'single':
                    page = app / 'web/index.html'
                    text = page.read_text(encoding='utf-8').replace('id="pairedSection" class=', 'id="pairedSection" hidden class=')
                    page.write_text(text.replace('0.5.0-rc.2', '0.5.0-rc.2 · 单设备版'), encoding='utf-8')
                    if platform == 'mac':
                        plist = app / 'macos/Info.plist'
                        plist.write_text(plist.read_text(encoding='utf-8').replace('local.usageledger.paired', 'local.usageledger.single'), encoding='utf-8')
                hashes = {str(p.relative_to(app)).replace('\\', '/'): sha(p) for p in sorted(app.rglob('*')) if p.is_file()}
                (app / 'SOURCE-SHA256.json').write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                archive = output / (name + '.zip')
                with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                    for file in sorted(app.rglob('*')):
                        if file.is_file():
                            info = zipfile.ZipInfo.from_file(file, name + '/' + str(file.relative_to(app)).replace('\\', '/'))
                            info.compress_type = zipfile.ZIP_DEFLATED
                            if file.suffix == '.command':
                                info.create_system = 3
                                info.external_attr = 0o100755 << 16
                            bundle.writestr(info, file.read_bytes())
                with zipfile.ZipFile(archive) as bundle:
                    if bundle.testzip():
                        raise ValueError('ZIP integrity check failed')
                archives.append(archive)
    (output / 'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in archives), encoding='ascii')
    print('\n'.join(str(p) for p in archives))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts')
    parser.add_argument('--cloudflared', type=Path)
    args = parser.parse_args()
    build(args.output, args.cloudflared)
