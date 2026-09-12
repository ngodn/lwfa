#!/usr/bin/env python3
"""Exercise USB failures before the installer can authenticate or sign."""
import os
from pathlib import Path
import pty
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


class USBPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.scripts = self.root / 'scripts'
        self.scripts.mkdir()
        for name in ('install-ios.sh', 'ios-usb-preflight.sh'):
            shutil.copyfile(SCRIPTS / name, self.scripts / name)
        (self.scripts / 'check-ios-ipa.py').write_text('pass\n')
        self.ipa = self.root / 'test app.ipa'
        self.ipa.write_bytes(b'test fixture')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        TEST_ROOT=str(self.root), LWFA_XTOOL=str(self.bin / 'xtool'))
        self.env.pop('LWFA_IPAD_UDID', None)
        self.tool('sleep', ':')
        self.tool('idevice_id', '''
count=0
[[ ! -f "$TEST_ROOT/count" ]] || read -r count < "$TEST_ROOT/count"
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_ROOT/count"
if [[ ${FAIL_LIST:-0} == 1 ]]; then exit 1; fi
if [[ ${DROP_AT:-0} -gt 0 && $count -ge $DROP_AT ]]; then exit 0; fi
printf '%s\\n' "${DEVICES-ipad-one}"
''')
        self.tool('ideviceinfo', '[[ ${FAIL_HANDSHAKE:-0} != 1 ]] || exit 1\necho 26.6.2')
        self.tool('xtool', '''
printf '%s\\n' "$*" >> "$TEST_ROOT/xtool-calls"
if [[ $1 == auth ]]; then echo 'Logged in.'; fi
''')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/bash\nset -eu\n' + body + '\n')
        path.chmod(0o755)

    def run_install(self, **env):
        master, slave = pty.openpty()
        try:
            return subprocess.run(
                ['bash', str(self.scripts / 'install-ios.sh'), str(self.ipa)],
                stdin=slave, capture_output=True, text=True,
                env=dict(self.env, **env), timeout=5)
        finally:
            os.close(master)
            os.close(slave)

    def test_usb_failure_prevents_authentication(self):
        cases = [dict(DEVICES=''), dict(FAIL_LIST='1'),
                 dict(FAIL_HANDSHAKE='1'), dict(DROP_AT='2'),
                 dict(DEVICES='ipad-one\nipad-two'),
                 dict(LWFA_IPAD_UDID='missing')]
        for env in cases:
            with self.subTest(env=env):
                (self.root / 'count').unlink(missing_ok=True)
                result = self.run_install(**env)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse((self.root / 'xtool-calls').exists())
                self.assertIn('Installation has not started.', result.stderr)

    def test_disconnect_after_auth_prevents_install(self):
        result = self.run_install(DROP_AT='4')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'xtool-calls').read_text(), 'auth status\n')

    def test_success_pins_checked_device(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'install --usb --udid ipad-one {self.ipa}\n',
                      (self.root / 'xtool-calls').read_text())

    def test_explicit_device_with_multiple_connected(self):
        result = self.run_install(DEVICES='ipad-one\nipad-two', LWFA_IPAD_UDID='ipad-two')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('install --usb --udid ipad-two ',
                      (self.root / 'xtool-calls').read_text())


if __name__ == '__main__':
    unittest.main()
