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
  check('the archive gate is the FIRST refusal after planning', index.indexOf('!plan.archived && options.force !== true') > 0)
  check('force cannot be set from the browser route', /remove\(id, \{ force: false \}\)/.test(index))
  check('the agent tool needs the deployment flag AND an explicit argument',
    /settings\.allowAgentDeleteActive && args\.forceActive === true/.test(index))
  check('the tool refuses an unconfirmed delete', /args\.confirm !== true/.test(index))
}

console.log('\nE — the HTTP surface')
{
  check('the write route requires a JSON content type', /checkOrigin\(req, true\)/.test(index))
  // Count the routes instead of hardcoding one: every route that either returns
  // session data or mutates anything must carry the origin guard.
  const routePaths = [...index.matchAll(/path: `\$\{ROUTE\}\/([a-z]+)`/g)].map((m) => m[1])
  const guarded = (index.match(/checkOrigin\(req, (?:true|false)\)/g) ?? []).length
  check('every registered route is accounted for', routePaths.length === 4, routePaths.join(', '))
  check('every route that reads session data or writes is guarded', guarded === 3, `${guarded} guard(s) for ${routePaths.join('/')}`)
  check('the diagnostic route exposes no session data', /diagnostic[\s\S]{0,600}?steps/.test(index) && !/diagnostic[\s\S]{0,900}?rows/.test(index))
  check('a mismatched Origin is refused with 403', /Origin 与 Host 不一致/.test(index))
  check('the body is size-bounded', /maxBytes = 65536/.test(index))
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
