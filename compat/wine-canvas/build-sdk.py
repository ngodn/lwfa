#!/usr/bin/env python3
"""Build both Wine Unix architectures in GE's pinned Steam Runtime SDK."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import digest, verify

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    base, work, output = (path.resolve() for path in (args.base, args.work, args.output))
    if args.jobs < 1 or work.exists() or output.exists():
        parser.error('Use new work/output directories and a positive job count')
    if work.is_relative_to(base) or output.is_relative_to(base):
        parser.error('Work and output must be outside the original runtime')
    manifest = json.loads((HERE / 'manifest.json').read_text())
    verify(base, manifest['base']['files'])
    sdk = json.loads((HERE / 'sdk.json').read_text())
    image = sdk['image'] + '@' + sdk['digest']
    subprocess.run(['docker', 'pull', '--platform', sdk['platform'], image], check=True)
    inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if image not in inspected['RepoDigests']:
        raise RuntimeError('Docker image digest does not match the pinned SDK')
    work.mkdir(parents=True)
    recipe = work / 'recipe'
    shutil.copytree(HERE, recipe, ignore=shutil.ignore_patterns('__pycache__'))
    cache = work / 'cache'
    cache.mkdir()
    if args.cache:
        for name, entry in manifest['source']['archives'].items():
            source = args.cache.resolve() / name
            if source.is_file():
                if digest(source) != entry['sha256']:
                    raise RuntimeError(f'Cached archive hash mismatch: {source}')
                shutil.copyfile(source, cache / name)
    provenance = dict(sdk, imageId=inspected['Id'], imageSize=inspected['Size'])
    (work / 'sdk-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    command = [
        'docker', 'run', '--rm', '--platform', sdk['platform'], '--user', f'{os.getuid()}:{os.getgid()}',
        '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--mount', f'type=bind,src={base},dst=/base,readonly',
        '--mount', f'type=bind,src={work},dst=/build',
        '--mount', f'type=bind,src={recipe},dst=/recipe,readonly',
        '--env', 'HOME=/build/home', '--env', 'LWFA_SDK_CONTAINER=' + sdk['digest'],
        '--env', 'LWFA_WINE_PKG_CONFIG_LIBDIR32=/usr/lib/i386-linux-gnu/pkgconfig:/usr/share/pkgconfig',
        '--entrypoint', 'python3', image, '/recipe/build.py', '--base', '/base',
        '--work', '/build/work', '--output', '/build/artifact', '--cache', '/build/cache',
        '--jobs', str(args.jobs), '--sdk-provenance', '/build/sdk-provenance.json',
    ]
    (work / 'home').mkdir()
    (work / 'container-command.json').write_text(json.dumps(command, indent=2) + '\n')
    subprocess.run(command, check=True)
    artifact = work / 'artifact'
    built = json.loads((artifact / 'manifest.json').read_text())
    if built['build'].get('kind') != 'steam-runtime-sdk' or not built['build'].get('portable'):
        raise RuntimeError('SDK build did not produce verified SDK metadata')
    verify(artifact / 'payload', built['patched']['files'])
    output.parent.mkdir(parents=True, exist_ok=True)
    artifact.rename(output)
    verify(base, manifest['base']['files'])
    print(f'Built Steam Runtime SDK artifact: {output}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'SDK build failed: {error}', file=sys.stderr)
        sys.exit(1)
