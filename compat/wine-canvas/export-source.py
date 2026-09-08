#!/usr/bin/env python3
"""Export matching prepared Wine sources for a completed SDK artifact."""
import argparse
import hashlib
import gzip
import io
import json
from pathlib import Path
import tarfile


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, required=True, help='Completed build-sdk.py work directory')
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New .tar.gz release asset')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output archive already exists')
    artifact = args.artifact.resolve()
    manifest = json.loads((artifact / 'manifest.json').read_text())
    if manifest['build'].get('kind') != 'steam-runtime-sdk':
        parser.error('Source export requires a completed SDK artifact')
    for relative, expected in manifest['patched']['files'].items():
        if sha256(artifact / 'payload' / relative) != expected:
            parser.error(f'Artifact payload hash mismatch: {relative}')
    wine = args.work.resolve() / 'work/source/wine'
    files = {}
    for root, prefix in [(wine, 'wine'), (artifact / 'source-recipe', 'recipe')]:
        if not root.is_dir():
            parser.error(f'Missing source directory: {root}')
        for path in sorted(root.rglob('*')):
            relative = path.relative_to(root)
            if '.git' in relative.parts or '__pycache__' in relative.parts:
                continue
            if path.is_file() or path.is_symlink():
                files[f'{prefix}/{relative.as_posix()}'] = path
    records = {}
    for name, path in files.items():
        records[name] = {'symlink': str(path.readlink())} if path.is_symlink() else {'sha256': sha256(path)}
    index = (json.dumps({'schemaVersion': 1, 'source': manifest['source'], 'files': records}, indent=2) + '\n').encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + '.partial')
    try:
        with temporary.open('wb') as destination, gzip.GzipFile(filename='', mode='wb', fileobj=destination, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w|') as archive:
            for name, path in files.items():
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                if info.isfile():
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
                else:
                    archive.addfile(info)
            info = tarfile.TarInfo('source-manifest.json')
            info.size = len(index)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(index))
        temporary.rename(args.output)
    finally:
        temporary.unlink(missing_ok=True)
    record = {'file': args.output.name, 'sha256': sha256(args.output),
              'contentsManifestSha256': hashlib.sha256(index).hexdigest(), 'files': len(files)}
    (artifact / 'source-archive.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
