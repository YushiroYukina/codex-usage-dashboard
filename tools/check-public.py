"""Reject machine state and local integration files from the public tree."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
forbidden = {'installation.json', 'status.json', 'private.json', 'paired-device.json', 'desktop-session.json', 'ledger-local-bridge.mjs'}
suffixes = {'.sqlite', '.dpapi', '.ulledger', '.ulsync', '.log', '.exe', '.zip'}
problems = []
for path in root.rglob('*'):
    relative = path.relative_to(root)
    if not path.is_file() or relative.parts[0] in {'.git', 'artifacts', 'vendor'} or '__pycache__' in relative.parts:
        continue
    if path.name in forbidden or path.suffix in suffixes or path.name.startswith('.env'):
        problems.append(str(relative))
    if path.suffix == '.json':
        json.loads(path.read_text(encoding='utf-8'))
    if path.suffix in {'.png', '.ico', '.icns'}:
        continue
    text = path.read_text(encoding='utf-8')
    for private_text in ['C:\\Users\\Administrator', 'gpt-niang-ledger05-local', 'D:\\下载']:
        if private_text in text and path.name != 'check-public.py':
            problems.append(str(relative))
if problems:
    raise SystemExit('Public-tree check failed: ' + ', '.join(problems))
print('Public-tree state and encoding checks passed')
