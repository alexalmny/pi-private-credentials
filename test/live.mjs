// Optional real-Chrome self-check. Uses only disposable, randomly generated test credentials.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import extension from '../src/index.ts';
import { Vault } from '../src/vault.mjs';

if (!process.env.PI_CREDENTIALS_TEST_PUPPETEER) throw new Error('Set PI_CREDENTIALS_TEST_PUPPETEER to a module exporting puppeteer.');
const { puppeteer } = await import(process.env.PI_CREDENTIALS_TEST_PUPPETEER);
const dir = await mkdtemp(join(homedir(), 'pi-credentials-test-'));
const agentDir = join(dir, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CREDENTIALS_CHROME_PROFILE = join(dir, 'profile');
const key = join(dir, 'test-key.pem'); const cert = join(dir, 'test-cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
  '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<form method="post"><label>Username<input id="username" type="email"></label><label>Password<input id="password" type="password"></label><button>Login</button></form>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.PI_CREDENTIALS_TEST_CHROME || '/snap/bin/chromium',
    headless: true, pipe: true, userDataDir: process.env.PI_CREDENTIALS_CHROME_PROFILE,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--ignore-certificate-errors'] });
  const [page] = await browser.pages(); await page.goto(origin);
  const password = randomBytes(24).toString('hex'); const username = 'test@example.invalid';
  const master = randomBytes(24).toString('hex');
  const tools = []; const commands = new Map(); const events = new Map();
  extension({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.push(tool); },
  });
  let prompts = 0; let approvals = 0;
  const notifications = [];
  const ctx = { mode: 'tui', executeTool() { throw new Error('Secrets must never use nested tools.'); }, ui: {
    notify(text) { notifications.push(text); },
    async select(_title, options) { approvals++; return options[0]; },
    async confirm() { return true; },
    async custom(factory) {
      prompts++;
      return new Promise(resolve => {
        const component = factory({ requestRender() {} }, { fg(_color, text) { return text; } }, {}, resolve);
        const values = component.allowRemember ? [username, password] : component.inputs.map(() => master);
        values.forEach((value, i) => { component.handleInput(value); if (i < values.length - 1) component.handleInput('\t'); });
        if (component.allowRemember) { component.handleInput('\t'); component.handleInput(' '); }
        const rendered = component.render(80).join('\n');
        for (const secret of [username, password, master]) assert.ok(!rendered.includes(secret));
        component.handleInput('\r');
      });
    },
  } };
  const params = { origin, usernameSelector: '#username', passwordSelector: '#password' };
  const tool = tools[0];
  const invoke = async () => {
    const output = await tool.execute('self-check', params, undefined, undefined, ctx);
    assert.notEqual(output.isError, true, notifications.join('; '));
    for (const secret of [username, password, master]) assert.ok(!JSON.stringify(output).includes(secret));
    assert.equal(await page.$eval('#password', input => input.value), password);
    return output;
  };
  await invoke(); assert.equal(prompts, 2); assert.equal(approvals, 0);
  await invoke(); assert.equal(prompts, 2); assert.equal(approvals, 1);
  const vault = new Vault(join(agentDir, 'private-credentials')); await vault.unlock(master);
  await vault.mutate(data => { data.mode = 'session'; });
  await invoke(); assert.equal(approvals, 1);
  await commands.get('credentials').handler('lock', ctx);
  await invoke(); assert.equal(prompts, 3); assert.equal(approvals, 2);
  await invoke(); assert.equal(approvals, 2);
  await vault.mutate(data => { data.mode = 'yolo'; });
  await invoke(); assert.equal(approvals, 2);
  const filtered = events.get('tool_result')({ content: [{ type: 'text', text: password }], details: { raw: password }, structuredContent: { raw: password } });
  assert.ok(!JSON.stringify(filtered).includes(password));
  const encrypted = await readFile(vault.file, 'utf8');
  for (const secret of [password, username, master]) assert.ok(!encrypted.includes(secret));
  // Origin changes and wrong field types fail without exposing anything.
  await page.evaluate(() => { document.querySelector('#password').type = 'text'; });
  const refused = await tool.execute('refuse', params, undefined, undefined, ctx);
  assert.equal(refused.isError, true); assert.ok(!JSON.stringify(refused).includes(password));
  events.get('session_shutdown')(); vault.lock();
  console.log('LIVE CHECK OK: real Chrome fill, masked TUI, encrypted remember/reuse, all approval modes, redaction, and unsafe field refusal.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
