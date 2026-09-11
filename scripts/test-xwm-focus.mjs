#!/usr/bin/env node
// Node 24. Run the patched XWM's protocol regression in private X namespaces.
import { spawnSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const xvfb = realpathSync(process.env.LWFA_TEST_XVFB || '/usr/bin/Xvfb');
const build = spawnSync('cargo', [
  'test', '--manifest-path', 'vendor/smithay/Cargo.toml',
  '--no-default-features', '--features', 'backend_winit,desktop,xwayland,wayland_frontend',
  '--lib', '--no-run', '--target-dir', 'target', '--message-format=json',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
const records = (build.stdout || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
for (const record of records) {
  if (record.reason === 'compiler-message' && record.message.level === 'error') {
    process.stderr.write(record.message.rendered || record.message.message);
  }
}
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const binary = records.find(record => record.reason === 'compiler-artifact'
  && record.target.name === 'smithay' && record.profile.test && record.executable)?.executable;
if (!binary) throw new Error('Cargo did not produce the Smithay test executable');

const args = ['--unshare-all', '--die-with-parent', '--new-session',
  '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dev', '/dev', '--proc', '/proc',
  '--ro-bind', resolve(binary), '/run/test', '--ro-bind', xvfb, '/run/Xvfb', '--chdir', '/tmp'];
for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
  args.push('--unsetenv', name);
}
for (const name of ['mnt', 'net']) {
  args.push('--setenv', `LWFA_TEST_PARENT_${name.toUpperCase()}`, readlinkSync(`/proc/self/ns/${name}`));
}
args.push('--', '/run/test', 'xwayland::xwm::active_window::tests::', '--ignored', '--nocapture');
const test = spawnSync('bwrap', args, { cwd: root, stdio: 'inherit', timeout: 45_000 });
if (test.error) throw test.error;
process.exit(test.status ?? 1);
