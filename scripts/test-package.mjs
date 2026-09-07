#!/usr/bin/env node
// Exercise the real packaging script in disposable repositories. No builds or installs.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const source = process.env.LWFA_PACKAGE_SCRIPT || fileURLToPath(new URL("./package.sh", import.meta.url))
const work = await mkdtemp(path.join(tmpdir(), "lwfa-package-test-"))
const version = "9.8.7"
const sentinel = Buffer.from("previous verified release must survive\n")
const executable = name => {
  const found = spawnSync("bash", ["-c", 'command -v "$1"', "package-fixture", name], { encoding: "utf8" })
  assert.equal(found.status, 0, `${name} must be available`)
  return found.stdout.trim()
}
const realCp = executable("cp")
const realTar = executable("tar")
const realCat = executable("cat")
const failures = []
let sequence = 0

async function file(name, content, executable = false) {
  await mkdir(path.dirname(name), { recursive: true })
  await writeFile(name, content)
  if (executable) await chmod(name, 0o755)
}

async function fixture() {
  // Spaces exercise the same quoting used when a checkout or TMPDIR is moved.
  const root = path.join(work, `fixture ${++sequence}`)
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await copyFile(source, path.join(root, "scripts/package.sh"))
  await file(path.join(root, "crates/lwfa-engine/Cargo.toml"), `[package]\nversion = "${version}"\n`)
  await file(path.join(root, "target/release/lwfa-engine"), "#!/usr/bin/env bash\nprintf 'fixture engine\\n'\n", true)
  await file(path.join(root, "packages/shell/dist/index.html"), "<title>Fixture shell</title>\n")
  await file(path.join(root, "packages/shell/dist/assets/main.js"), "console.log('fixture shell')\n")
  await file(path.join(root, "install.sh"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$LWFA_INSTALL_MARKER"\nexit "$LWFA_INSTALL_EXIT"\n', true)
  await file(path.join(root, "configs/defaults.toml"), "[window]\nwidth = 1000\n")
  await file(path.join(root, "deploy/user.service"), "fixture deployment\n")
  await file(path.join(root, "deploy/local/private.txt"), "must not ship\n")
  await file(path.join(root, "deploy/docker/certs/private.pem"), "must not ship\n")
  await file(path.join(root, "docs/setup.md"), "fixture documentation\n")
  await file(path.join(root, "README.md"), "fixture README\n")
  await file(path.join(root, "LICENSE"), "fixture license\n")
  const library = path.join(work, `fixture-library-${sequence}/libfixture.so.1`)
  await file(library, "fixture library bytes\n")
  const bin = path.join(root, "fixture-bin")
  await file(path.join(bin, "ldd"), `#!/usr/bin/env bash
case "$LWFA_PACKAGE_FAIL" in
  ldd) echo 'injected ldd failure' >&2; exit 72 ;;
  missing-library) printf '\tlibmissing.so.1 => not found\n'; exit 0 ;;
esac
printf '\tlibfixture.so.1 => %s (0x1234)\n' "$LWFA_FIXTURE_LIBRARY"
`, true)
  await file(path.join(bin, "patchelf"), `#!/usr/bin/env bash
if [ "$LWFA_PACKAGE_FAIL" = patchelf ]; then echo 'injected patchelf failure' >&2; exit 73; fi
exit 0
`, true)
  await file(path.join(bin, "cp"), `#!/usr/bin/env bash
if [ "$LWFA_PACKAGE_FAIL" = cp ]; then echo 'injected cp failure' >&2; exit 71; fi
exec "$LWFA_REAL_CP" "$@"
`, true)
  await file(path.join(bin, "tar"), `#!/usr/bin/env bash
if [ "$LWFA_PACKAGE_FAIL" = tar ]; then
  for arg in "$@"; do
    if [[ "$arg" == --create || "$arg" =~ ^-?[a-z]*c[a-z]*$ ]]; then
      echo 'injected tar creation failure' >&2
      exit 74
    fi
  done
fi
exec "$LWFA_REAL_TAR" "$@"
`, true)
  await file(path.join(bin, "cat"), `#!/usr/bin/env bash
if [ "$LWFA_PACKAGE_FAIL" = append ]; then
  for arg in "$@"; do
    if [[ "$arg" == */payload.tar.gz ]]; then
      echo 'injected payload append failure' >&2
      exit 75
    fi
  done
fi
exec "$LWFA_REAL_CAT" "$@"
`, true)
  const scratch = path.join(root, "owned temporary files")
  await mkdir(scratch)
  const out = path.join(root, `releases/lwfa-${version}.run`)
  await file(out, sentinel)
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: scratch,
    LWFA_ENGINE: path.join(root, "target/release/lwfa-engine"),
    LWFA_FIXTURE_LIBRARY: library,
    LWFA_REAL_CP: realCp,
    LWFA_REAL_TAR: realTar,
    LWFA_REAL_CAT: realCat,
    LWFA_INSTALL_MARKER: path.join(root, "installer-called"),
    LWFA_INSTALL_EXIT: "0",
    LWFA_PACKAGE_FAIL: "",
    LWFA_PACKAGE_OWNER: "",
  }
  const run = (args, extra = {}, timeout = 10000) => spawnSync("bash", args, {
    cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout, maxBuffer: 128 * 1024,
  })
  const packageIt = (fail, extra = {}) => run([path.join(root, "scripts/package.sh"), "--no-build"], { ...extra, LWFA_PACKAGE_FAIL: fail || "" })
  const clean = async () => {
    assert.deepEqual(await readdir(scratch), [], "Owned temporary staging/unpack directories are cleaned")
    assert.deepEqual(await readdir(path.join(root, "releases")), [`lwfa-${version}.run`], "No partial output remains beside the release")
  }
  return { root, out, scratch, run, packageIt, clean, marker: env.LWFA_INSTALL_MARKER }
}

async function test(name, body) {
  try { await body(); console.log(`PASS: ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${error.stack}`) }
}

function succeeded(result, context) {
  assert(!result.error, `${context}: ${result.error?.message}`)
  assert.equal(result.status, 0, `${context}: ${result.stderr}\n${result.stdout}`)
}

try {
  await test("an unwritable legacy target/package cannot poison a new package", async () => {
    const f = await fixture()
    const legacy = path.join(f.root, "target/package")
    const oldStage = path.join(legacy, `lwfa-${version}`)
    await file(path.join(oldStage, "preserve.txt"), "old staging is not ours\n")
    await chmod(oldStage, 0o555)
    await chmod(legacy, 0o555)
    try {
      succeeded(f.packageIt("", { LWFA_PACKAGE_OWNER: `${process.getuid()}:${process.getgid()}` }), "package with protected legacy staging")
      const extract = path.join(f.root, "extracted payload")
      succeeded(f.run([f.out, "--extract", extract]), "extract generated archive")
      const payload = path.join(extract, `lwfa-${version}`)
      assert.equal(await readFile(path.join(payload, "share/lwfa/shell/index.html"), "utf8"), "<title>Fixture shell</title>\n")
      assert.equal(await readFile(path.join(payload, "lib/libfixture.so.1"), "utf8"), "fixture library bytes\n")
      assert.equal(await readFile(path.join(payload, "docs/setup.md"), "utf8"), "fixture documentation\n")
      assert.equal(await readFile(path.join(oldStage, "preserve.txt"), "utf8"), "old staging is not ours\n")
      assert(!(await readdir(path.join(payload, "deploy"))).includes("local"))
      assert(!(await readdir(path.join(payload, "deploy/docker"))).includes("certs"))
      await f.clean()
    } finally {
      await chmod(legacy, 0o755)
      await chmod(oldStage, 0o755)
    }
  })
  for (const fail of ["cp", "ldd", "patchelf", "tar", "append", "missing-library"]) {
    await test(`${fail} failure preserves the previous release and cleans staging`, async () => {
      const f = await fixture()
      const result = f.packageIt(fail)
      assert(!result.error, `${fail}: script should exit itself, ${result.error?.message}`)
      assert.notEqual(result.status, 0, `${fail}: packaging must fail\n${result.stdout}`)
      assert.deepEqual(await readFile(f.out), sentinel, "Failed packaging must not replace the previous release")
      await f.clean()
    })
  }
  await test("generated --extract without a destination exits promptly without installing", async () => {
    const f = await fixture()
    succeeded(f.packageIt(), "package for argument validation")
    const result = f.run([f.out, "--extract"], {}, 1500)
    assert(!result.error, `Missing argument must exit promptly, ${result.error?.message}`)
    assert.notEqual(result.status, 0, "Missing extraction destination is an error")
    assert(!(await readdir(f.root)).includes("installer-called"), "Invalid arguments never run installation")
    await f.clean()
  })
  await test("the generated installer forwards arguments and removes its temporary payload", async () => {
    const f = await fixture()
    succeeded(f.packageIt(), "package for cleanup check")
    succeeded(f.run([f.out, "--fixture-argument", "value with spaces"]), "run isolated fixture installer")
    assert.equal(await readFile(f.marker, "utf8"), "--fixture-argument\nvalue with spaces\n")
    await f.clean()
  })
  await test("a failing installer preserves its exit status and removes its temporary payload", async () => {
    const f = await fixture()
    succeeded(f.packageIt(), "package for failing installer check")
    const result = f.run([f.out, "--fixture-failure"], { LWFA_INSTALL_EXIT: "31" })
    assert(!result.error, `Failing installer must exit promptly, ${result.error?.message}`)
    assert.equal(result.status, 31, "The archive preserves the installer's failure status")
    assert.equal(await readFile(f.marker, "utf8"), "--fixture-failure\n")
    await f.clean()
  })
} finally {
  await rm(work, { recursive: true, force: true })
}
assert.deepEqual(failures, [], "Packaging regression checks failed")
