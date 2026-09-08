#!/usr/bin/env python3
"""Build the pinned canvas compatibility components without changing a runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(root, files):
    for relative, expected in files.items():
        path = root / relative
        if not path.is_file() or digest(path) != expected:
            raise RuntimeError(f'Pinned file mismatch: {path}')


def download(path, record):
    if path.exists():
        if digest(path) != record['sha256']:
            raise RuntimeError(f'Cached input hash mismatch: {path}')
        return
    temporary = path.with_suffix(path.suffix + '.download')
    try:
        with urllib.request.urlopen(record['url'], timeout=120) as source, temporary.open('wb') as output:
            shutil.copyfileobj(source, output)
        if digest(temporary) != record['sha256']:
            raise RuntimeError(f'Download hash mismatch: {record["url"]}')
        temporary.rename(path)
    finally:
        temporary.unlink(missing_ok=True)


def extract(archive, destination):
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix='.extract-') as temporary:
        folder = Path(temporary)
        with tarfile.open(archive) as bundle:
            bundle.extractall(folder, filter='data')
        roots = list(folder.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise RuntimeError(f'Unexpected archive layout: {archive}')
        if destination.exists():
            destination.rmdir()  # Only an empty upstream submodule placeholder is allowed.
        roots[0].rename(destination)


def run(command, cwd, log, env=None):
    with log.open('a') as output:
        output.write('\n' + repr(command) + '\n')
        output.flush()
        subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)


def exports(path):
    output = subprocess.check_output(['nm', '-D', '--defined-only', str(path)], text=True)
    return sorted(line.split()[-1] for line in output.splitlines() if len(line.split()) >= 3)


def glibc_floor(paths):
    versions = set()
    for path in paths:
        output = subprocess.check_output(['readelf', '--version-info', str(path)], text=True)
        versions.update(tuple(map(int, version.split('.'))) for version in re.findall(r'GLIBC_([0-9.]+)', output))
    return '.'.join(map(str, max(versions))) if versions else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True, help='Exact original GE-Proton11-6-x86_64 runtime')
    parser.add_argument('--work', type=Path, required=True, help='New directory for source and build logs')
    parser.add_argument('--output', type=Path, required=True, help='New artifact directory, never an installed runtime')
    parser.add_argument('--cache', type=Path, help='Optional directory containing pinned input archives')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--lib32-dir', type=Path, help='Optional private 32-bit development library directory')
    parser.add_argument('--sdk-provenance', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--prepare-only', action='store_true', help='Verify source preparation without compiling')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error('Python 3.12 or newer is required for safe tar extraction')
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    base, work, output = args.base.resolve(), args.work.resolve(), args.output.resolve()
    if work.exists() or output.exists():
        parser.error('--work and --output must not already exist')
    if work.is_relative_to(base) or output.is_relative_to(base):
        parser.error('Build and artifact directories must be outside the original runtime')
    manifest = json.loads((HERE / 'manifest.json').read_text())
    verify(base, manifest['base']['files'])
    verify(HERE, manifest['patches'])
    restoration = manifest['configureRestoration']
    verify(HERE, {restoration['path']: restoration['sha256'], 'prepare.sh': manifest['preparerSha256']})
    work.mkdir(parents=True)
    cache = args.cache.resolve() if args.cache else work / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    source = manifest['source']
    for name, record in source['archives'].items():
        download(cache / name, record)
    ge = work / 'source'
    extract(cache / 'ge.tar.gz', ge)
    extract(cache / 'wine.tar.gz', ge / 'wine')
    extract(cache / 'staging.tar.gz', ge / 'wine-staging')
    wine = ge / 'wine'
    log = work / 'build.log'
    print(f'Preparing pinned {source["tag"]} sources; log: {log}', flush=True)
    run(['bash', str(HERE / 'prepare.sh'), str(ge), str(HERE / restoration['path'])], work, log)
    for name, record in source['vulkanInputs'].items():
        download(wine / name, record)
    run(['dlls/winevulkan/make_vulkan', '-x', 'vk.xml', '-X', 'video.xml'], wine, log)
    run(['./tools/make_specfiles'], wine, log)
    verify(wine, source['preparedFiles'])
    for patch in manifest['patches']:
        run(['patch', '--batch', '-Np1', '--fuzz=0', '-i', str(HERE / patch)], wine, log)
    if args.prepare_only:
        print(f'Prepared source verified: {wine}')
        return
    sdk = None
    if args.sdk_provenance:
        sdk = json.loads(args.sdk_provenance.read_text())
        pinned = json.loads((HERE / 'sdk.json').read_text())
        if any(sdk.get(key) != value for key, value in pinned.items()):
            raise RuntimeError('SDK provenance does not match the pinned SDK')
        if not Path('/.dockerenv').exists() or os.environ.get('LWFA_SDK_CONTAINER') != pinned['digest']:
            raise RuntimeError('SDK artifacts must be compiled through build-sdk.py')
        sdk['osRelease'] = Path('/etc/os-release').read_text()
        sdk['compiler'] = subprocess.check_output(['cc', '--version'], text=True).splitlines()[0]
    products = {}
    configure_features = ['--with-xinput', '--with-xinput2', '--with-xrender']
    build64 = work / 'build64'
    build64.mkdir()
    run([str(wine / 'configure'), '--enable-win64', '--without-mingw', '--disable-tests', *configure_features, 'CFLAGS=-O2 -g'], build64, log)
    targets = ['dlls/win32u/win32u.so', 'dlls/winex11.drv/winex11.so']
    run(['make', f'-j{args.jobs}', *targets, 'server/wineserver'], build64, log)
    build32 = work / 'build32'
    build32.mkdir()
    env32 = os.environ.copy()
    env32['PKG_CONFIG_LIBDIR'] = os.environ.get('LWFA_WINE_PKG_CONFIG_LIBDIR32', '/usr/lib32/pkgconfig:/usr/share/pkgconfig')
    if args.lib32_dir:
        lib32 = args.lib32_dir.resolve(strict=True)
        env32['LDFLAGS'] = env32.get('LDFLAGS', '') + ' -L' + shlex.quote(str(lib32))
    run([str(wine / 'configure'), f'--with-wine64={build64}', '--without-mingw', '--disable-tests', *configure_features, 'CFLAGS=-O2 -g'], build32, log, env32)
    for build in [build64, build32]:
        config = (build / 'include/config.h').read_text()
        for macro in ['SONAME_LIBXI', 'SONAME_LIBXRENDER', 'HAVE_X11_EXTENSIONS_XINPUT2_H']:
            if not re.search(r'^#define ' + macro + r' ', config, re.MULTILINE):
                raise RuntimeError(f'Required graphics/input feature missing from {build.name}: {macro}')
    run(['make', f'-j{args.jobs}', *targets], build32, log, env32)
    for arch, build in [('x86_64', build64), ('i386', build32)]:
        for target in targets:
            product = build / target
            relative = f'files/lib/wine/{arch}-unix/{product.name}'
            if exports(product) != exports(base / relative):
                raise RuntimeError(f'Unix export ABI differs from the pinned runtime: {relative}')
            products[relative] = product
    products['files/bin/wineserver'] = build64 / 'server/wineserver'
    # Artifact creation is last. A failed build never advertises a usable payload.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.wine-canvas-artifact-') as temporary:
        staging = Path(temporary) / 'artifact'
        staging.mkdir()
        for relative, product in products.items():
            destination = staging / 'payload' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(product, destination)
            destination.chmod(0o755)
        result = {
            'schemaVersion': 1,
            'base': manifest['base'],
            'patched': {'files': {relative: digest(product) for relative, product in products.items()}},
            'build': {'kind': 'steam-runtime-sdk' if sdk else 'host', 'portable': bool(sdk), 'architectures': ['x86_64', 'i386'],
                      'glibcFloor': glibc_floor(products.values()),
                      'sourceManifestSha256': digest(HERE / 'manifest.json'),
                      'requiredFeatures': {arch: ['xinput2', 'xrender'] for arch in ['x86_64', 'i386']}},
            'source': {'tag': source['tag'], 'geCommit': source['geCommit'],
                       'wineRevision': source['wineRevision'], 'stagingRevision': source['stagingRevision']},
        }
        if sdk:
            result['build']['sdk'] = sdk
            original_floor = glibc_floor(base / relative for relative in products)
            if tuple(map(int, result['build']['glibcFloor'].split('.'))) > tuple(map(int, original_floor.split('.'))):
                raise RuntimeError('SDK payload requires newer GLIBC than the original GE components')
            result['build']['baseGlibcFloor'] = original_floor
        (staging / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
        recipe = staging / 'source-recipe'
        recipe.mkdir()
        for name in ['manifest.json', 'build.py', 'build-sdk.py', 'export-source.py', 'sdk.json', 'prepare.sh', 'README.md']:
            shutil.copy2(HERE / name, recipe / name)
        shutil.copytree(HERE / 'patches', recipe / 'patches')
        shutil.copy2(wine / 'COPYING.LIB', staging / 'COPYING.Wine.LIB')
        features = staging / 'build-features'
        features.mkdir()
        for arch, build in [('x86_64', build64), ('i386', build32)]:
            directory = features / arch
            directory.mkdir()
            for relative in ['include/config.h', 'config.status', 'config.log']:
                shutil.copy2(build / relative, directory / Path(relative).name)
        if args.lib32_dir:
            dependencies = {}
            for name in ['libXi.so.6', 'libXrender.so.1']:
                path = args.lib32_dir.resolve() / name
                if path.is_file():
                    dependencies[name] = {'sha256': digest(path), 'buildPath': str(path)}
            (features / 'private-lib32.json').write_text(json.dumps(dependencies, indent=2) + '\n')
        (features / 'README.txt').write_text(
            'These files record detected optional libraries and configure arguments.\n'
            'Matching Unix export names does not establish feature parity with upstream GE.\n'
            + ('This artifact was compiled in the pinned Steam Runtime SDK.\n' if sdk else
             'This artifact was built on the current host, outside the Steam Runtime SDK.\n'))
        staging.rename(output)
    verify(base, manifest['base']['files'])
    print(f'Built {"SDK" if sdk else "host-specific"} artifact: {output}\nNo installed runtime or Wine prefix was modified.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Build failed: {error}', file=sys.stderr)
        sys.exit(1)
