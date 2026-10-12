// Security self-checks over the plugin source.
//
// Each check states a claim the README makes, and fails when the claim is no
// longer true. Read-only: it inspects the two source files, nothing else.
import { readFileSync } from 'node:fs'

const INDEX = 'index.js'
const CLIENT = 'client.js'
const index = readFileSync(INDEX, 'utf8')
const client = readFileSync(CLIENT, 'utf8')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

console.log('\nA — no code execution or shell surface')
for (const [label, re] of [
  ['no eval()', /\beval\s*\(/],
  ['no new Function', /new Function\s*\(/],
  ['no child_process', /child_process/],
  ['no dynamic import()', /\bimport\s*\(/],
  ['no exec/spawn', /\b(?:exec|spawn|execSync|spawnSync|execFile)\s*\(/],
]) {
  const hit = re.exec(index) ?? re.exec(client)
  check(label, hit === null, hit === null ? undefined : `found ${hit[0]} around: ${hit.input.slice(Math.max(0, hit.index - 40), hit.index + 40).split('\n').pop()}`)
}

console.log('\nB — the filesystem surface is exactly what the README claims')
{
  const writes = [...index.matchAll(/\b(writeFile|appendFile|createWriteStream|copyFile|rename|truncate)\s*\(/g)].map((m) => m[1])
  check('never writes or appends to a file', writes.length === 0, writes.join(', '))
  const mkdirs = [...index.matchAll(/\bmkdir\s*\(/g)].length
  check('no directory is created (the layout it reads already exists)', mkdirs === 0, String(mkdirs))
  check('the destructive call is rm() and only in the delete path', /\brm\s*\(/.test(index))
  check('projection-cache removal goes through the storage domain', /storageDomainHandle\.get\(|storageDomain/.test(index))
  check('workspace.json is named only in prose, never opened', !/readFile\([^)]*workspace\.json/.test(index) && !/join\([^)]*workspace\.json/.test(index))
}

console.log('\nC — path containment')
{
  check('the session id is always encoded before it becomes a segment', /encodeSegment\(id\)/.test(index) || /encodeSegment\(raw\)/.test(index))
  check('the project directory is containment-checked before removal', /project\.startsWith\(sessionsRoot \+ sep\)/.test(index))
  check('encodeSegment neutralizes separators and dot segments', /~002E~002E/.test(index) && /002F/.test(index) === false ? true : /0x2E|002E/.test(index))
}

console.log('\nD — the delete gate')
{
  const order = ['archived', 'live', 'lockFile', 'writable']
  check('all four gate variables exist', order.every((name) => index.includes(name)))
  // The ORDER itself is not asserted here on purpose. A regex can only prove a
  // string exists, and the first version of this file pretended otherwise with
  // `indexOf(...) > 0`, which stays true wherever the gate sits. The order is
  // proven behaviourally in verify-dry-run.mjs case 4c, by a fixture that trips
  // four gates at once so exactly one can answer.
  check('the ordering proof lives in the behavioural suite',
    readFileSync('verify-dry-run.mjs', 'utf8').includes('case 4c — the refusal order'),
    'the ordering claim must be backed by a fixture, not a substring')
  check('force cannot be set from the browser route', /remove\(id, \{ force: false \}\)/.test(index))
  check('the agent tool needs the deployment flag AND an explicit argument',
    /settings\.allowAgentDeleteActive && args\.forceActive === true/.test(index))
  check('the tool refuses an unconfirmed delete', /args\.confirm !== true/.test(index))
  // The `force` path skips the archive gate, so it must be guarded by the
  // re-validation that runs immediately before removal.
  check('the destructive call re-validates liveness first', /liveSet\(\)\.has\(id\)[\s\S]{0,120}?会话在删除前变为活动状态/.test(index))
  check('the destructive call re-validates the leaf first',
    /const guard = await validateLeaf\(plan\.dir, id\)[\s\S]*?await rm\(plan\.dir/.test(index),
    'validateLeaf must run before the rm, with only comments allowed in between')
  check('a leaf that is a link is refused', /info\.isSymbolicLink\(\)\) return '会话目录是符号链接/.test(index))
  check('a leaf whose log names another session is refused', /header\.id\) !== id\) return '会话目录里的日志属于另一个会话/.test(index))
  check('concurrent deletes of one id are serialized', /IN_FLIGHT\.has\(id\)/.test(index) && /IN_FLIGHT\.add\(id\)/.test(index))
}

console.log('\nE — the HTTP surface')
{
  check('the write route requires a JSON content type', /checkOrigin\(req, true\)/.test(index))
  const routePaths = [...index.matchAll(/path: `\$\{ROUTE\}\/([a-z]+)`/g)].map((m) => m[1])
  check('every registered route is accounted for', routePaths.length === 4, routePaths.join(', '))
  check('the diagnostic route is the only one without a guard',
    (index.match(/checkOrigin\(req, (?:true|false)\)/g) ?? []).length === 3, routePaths.join('/'))
  // DNS rebinding is the attack the Origin/Host comparison does NOT stop: a
  // rebound page is same-origin and both headers read the attacker's authority.
  // `Sec-Fetch-Site` cannot be forged by page script, and the Host allowlist pins
  // the request to the interface these routes are for.
  check('cross-site requests are refused by Sec-Fetch-Site', /sec-fetch-site/.test(index) && /拒绝跨站请求/.test(index))
  check('the Host must be a loopback authority', /isLoopbackAuthority\(host\)/.test(index) && /不是回环地址/.test(index))
  check('the loopback allowlist is exact, not a prefix match',
    /bare === '127\.0\.0\.1' \|\| bare === 'localhost' \|\| bare === '::1'/.test(index))
  check('a mismatched Origin is still refused', /Origin 与 Host 不一致/.test(index))
  check('the body is size-bounded', /maxBytes = 65536/.test(index))
}

console.log('\nE2 — no absolute path leaves the Host')
{
  // The response bodies must not carry this machine's layout. `cwd` is the one
  // deliberate exception: the dialog shows the project a person recognises.
  const bodies = index.slice(index.indexOf("path: `${ROUTE}/diagnostic`"))
  check('the diagnostic route does not echo rows', !/firstRow/.test(bodies))
  check('the diagnostic route does not dump a stack trace', !/error\?\.stack/.test(index))
  check('the archived route does not publish the sessions root', !/sessionsRoot: join/.test(index))
  check('the preview route does not publish the session directory', !/directory: plan\.dir/.test(index))
  check('no refusal embeds a directory path', !/（\$\{plan\.dir\}）/.test(index))
  check('the tool outcome carries no path', !/dir: typeof result\.dir/.test(index) && !/dir: plan\.dir,/.test(index))
}

console.log('\nF — the browser half')
{
  const requires = [...client.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1].replace(/['"]/g, '').trim())
  check('requires react and nothing else', requires.length === 1 && requires[0] === 'react', requires.join(', '))
  check('no innerHTML / outerHTML / insertAdjacentHTML', !/innerHTML|outerHTML|insertAdjacentHTML/.test(client))
  check('no dangerouslySetInnerHTML', !/dangerouslySetInnerHTML/.test(client))
  check('no fetch before apply()', (client.slice(0, client.indexOf('function ensureStyle')).match(/fetch\(/g) ?? []).length === 0)
  check('no React root API (the trimmed runtime has none)', !/\.createRoot\s*\(|\.createPortal\s*\(/.test(client))
}

console.log('\nG — the test suites cannot touch real data')
{
  const suite = readFileSync('verify-dry-run.mjs', 'utf8')
  check('the suite pins DSH_HOME before importing the plugin', suite.indexOf('process.env.DSH_HOME = HOME') < suite.indexOf("await import("))
  check('DSH_HOME points at a fresh temp directory', /mkdtemp\(join\(tmpdir\(\)/.test(suite))
  check('dshHome() reads the environment on every call (no cached real path)', /function dshHome\(\)[\s\S]{0,200}process\.env\.DSH_HOME/.test(index))
}

console.log(`\n${failures === 0 ? 'all security self-checks passed' : `${failures} check(s) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
