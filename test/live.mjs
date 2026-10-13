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
  res.end(`<form method="post"><label>Username<input id="username" type="email"></label><label>Password<input id="password" type="password"></label><label>Code<input id="code" type="text"></label><label>Note<textarea id="note"></textarea></label><button>Login</button></form>
    <script>
      const state = { username: '', password: '', code: '', note: '' };
      for (const input of document.querySelectorAll('input,textarea')) {
        for (const event of ['input', 'change']) input.addEventListener(event, () => {
          state[input.id] = input.value;
          for (const field of document.querySelectorAll('input,textarea')) field.value = state[field.id];
        });
      }
    </script>`);
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
  let formValues; let rememberEntry = true;
  const notifications = [];
  const ctx = { mode: 'tui', executeTool() { throw new Error('Secrets must never use nested tools.'); }, ui: {
    notify(text) { notifications.push(text); },
    async select(_title, options) { approvals++; return options[0]; },
    async confirm() { return true; },
    async custom(factory) {
      prompts++;
      return new Promise(resolve => {
        const component = factory({ requestRender() {} }, { fg(_color, text) { return text; } }, {}, resolve);
        const values = formValues ?? (component.allowRemember ? [username, password] : component.inputs.map(() => master));
        values.forEach((value, i) => { component.handleInput(value); if (i < values.length - 1) component.handleInput('\t'); });
        if (component.allowRemember && rememberEntry) { component.handleInput('\t'); component.handleInput(' '); }
        const rendered = component.render(80).join('\n');
        values.forEach((value, index) => { if (component.inputs[index].hidden) assert.ok(!rendered.includes(value)); });
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
  // Generic mixed form: only the explicitly remembered reusable field is persisted.
  await vault.mutate(data => { data.mode = 'ask'; });
  const accountID = 'generic-account'; const firstCode = '601234';
  const form = { origin, fields: [
    { label: 'Account ID', selector: '#username', hidden: false, temporary: false },
    { label: 'WhatsApp code', selector: '#code', hidden: true, temporary: true },
  ] };
  const invokeForm = async params => {
    const output = await tool.execute('generic-check', params, undefined, undefined, ctx);
    assert.notEqual(output.isError, true, notifications.join('; '));
    for (const value of formValues ?? []) assert.ok(!JSON.stringify(output).includes(value));
    return output;
  };
  formValues = [accountID, firstCode];
  await invokeForm(form);
  assert.equal(await page.$eval('#username', el => el.value), accountID);
  assert.equal(await page.$eval('#code', el => el.value), firstCode);
  let data = await vault.read();
  assert.equal(data.fields.length, 1); assert.equal(data.fields[0].value, accountID);
  assert.ok(!JSON.stringify(data).includes(firstCode));
  const oldApprovals = approvals;
  formValues = ['709876'];
  await invokeForm(form);
  assert.equal(approvals, oldApprovals + 1);
  assert.equal(await page.$eval('#username', el => el.value), accountID);
  assert.equal(await page.$eval('#code', el => el.value), formValues[0]);
  await vault.mutate(data => { data.mode = 'session'; });
  formValues = ['714902']; await invokeForm(form);
  assert.equal(approvals, oldApprovals + 1);
  await vault.mutate(data => { data.mode = 'yolo'; });
  formValues = ['715903']; await invokeForm(form);
  assert.equal(approvals, oldApprovals + 1);
  // All-temporary input must not unlock or touch a locked vault, or offer Remember.
  await commands.get('credentials').handler('lock', ctx);
  const before = await readFile(vault.file, 'utf8');
  const previousPrompts = prompts;
  formValues = ['802468', 'visible-note'];
  await invokeForm({ origin, fields: [
    { label: 'WhatsApp code', selector: '#code', hidden: true, temporary: true },
    { label: 'Note', selector: '#note', hidden: false, temporary: true },
  ] });
  assert.equal(prompts, previousPrompts + 1);
  assert.equal(await readFile(vault.file, 'utf8'), before);
  assert.equal(await page.$eval('#note', el => el.value), 'visible-note');
  // Even an existing remembered selector is not reused when requested as temporary.
  formValues = ['one-time-account'];
  await invokeForm({ origin, fields: [{ ...form.fields[0], temporary: true }] });
  assert.equal(await page.$eval('#username', el => el.value), formValues[0]);
  assert.equal(await readFile(vault.file, 'utf8'), before);
  formValues = undefined;
  // Origin changes and wrong field types fail without exposing anything.
  await page.evaluate(() => { document.querySelector('#password').type = 'text'; });
  const refused = await tool.execute('refuse', params, undefined, undefined, ctx);
  assert.equal(refused.isError, true); assert.ok(!JSON.stringify(refused).includes(password));
  events.get('session_shutdown')(); vault.lock();
  console.log('LIVE CHECK OK: legacy + generic forms, visible/masked entry, encrypted reuse, temporary non-storage/no-unlock, textareas, approval modes, redaction, controlled rerenders, and unsafe field refusal.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
