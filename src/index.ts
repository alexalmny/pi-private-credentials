import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Vault, exactOrigin, MODES } from './vault.mjs';
import { pageTargets, CDP } from './browser.mjs';
import { privatePrompt } from './private-ui.mjs';
import { Redactor, needsApproval } from './redact.mjs';

export default function (pi: ExtensionAPI) {
  const vault = new Vault(join(getAgentDir(), 'private-credentials'));
  const approved = new Set<string>();
  const redactor = new Redactor();
  const lock = () => { vault.lock(); approved.clear(); redactor.clear(); };
  pi.on('session_start', lock);
  pi.on('session_before_switch', lock);
  pi.on('session_before_fork', lock);
  pi.on('session_shutdown', lock);

  pi.on('tool_result', event => {
    if (!redactor.values.size) return;
    return {
      content: event.content.map(block => block.type === 'text' ? { ...block, text: redactor.text(block.text) } : block),
      details: redactor.json(event.details),
      structuredContent: redactor.json(event.structuredContent),
    };
  });

  async function unlock(ctx: ExtensionContext, signal?: AbortSignal) {
    if (vault.unlocked) return true;
    const existing = await vault.exists();
    const entry = await privatePrompt(ctx, existing ? 'Unlock encrypted credential bank' : 'Create vault: choose a strong master passphrase (12+ characters)',
      existing ? ['Master passphrase'] : ['Master passphrase', 'Repeat master passphrase'], false, signal);
    if (!entry) return false;
    try {
      if (!existing && entry.values[0] !== entry.values[1]) throw new Error('Master passphrases did not match.');
      await vault.unlock(entry.values[0]);
    } finally { entry.values.fill(''); }
    return true;
  }

  async function chromeProfile() {
    if (process.env.PI_CREDENTIALS_CHROME_PROFILE) return process.env.PI_CREDENTIALS_CHROME_PROFILE;
    const config = JSON.parse(await readFile(join(getAgentDir(), 'mcp.json'), 'utf8'));
    const args: string[] = config.mcpServers?.['chrome-devtools']?.args ?? [];
    const index = args.indexOf('--userDataDir');
    const profile = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--userDataDir='))?.slice(14);
    if (!profile) throw new Error('Configure PI_CREDENTIALS_CHROME_PROFILE or Chrome MCP --userDataDir.');
    return profile.startsWith('~/') ? join(homedir(), profile.slice(2)) : profile;
  }

  pi.registerTool(defineTool({
    name: 'secure_fill_credentials',
    label: 'Private credential fill',
    description: 'Privately request or reuse credentials and fill Chrome without putting secrets in tool arguments/results. Navigate with Chrome MCP first; obtain CSS selectors without reading field values. Provide an exact HTTPS origin and one visible input[type=password] selector; optionally a username input selector. Requires interactive Pi TUI and exactly one tab at that origin. Top-level document only. User controls remembering and approval policy. Never ask for passwords in chat or call MCP fill/evaluate with secrets. This tool only fills, never submits; do not read filled values or authentication request bodies afterward.',
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: Type.Object({
      origin: Type.String({ description: 'Exact HTTPS origin, e.g. https://example.com, without trailing slash or path', maxLength: 2048 }),
      passwordSelector: Type.String({ description: 'Unique CSS selector for the visible password input', minLength: 1, maxLength: 2048 }),
      usernameSelector: Type.Optional(Type.String({ description: 'Unique CSS selector for username/email input; omit on password-only steps', minLength: 1, maxLength: 2048 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      let browser: CDP | undefined;
      let credential: { username: string; password: string } | undefined;
      try {
        if (ctx.mode !== 'tui') throw new Error('Private credentials require interactive Pi TUI.');
        const origin = exactOrigin(params.origin);
        const targets = await pageTargets(await chromeProfile(), origin);
        if (targets.length !== 1) throw new Error('Open exactly one Chrome tab at the requested HTTPS origin.');
        browser = await CDP.connect(targets[0].ws, signal);
        const windowId = await browser.window();
        await browser.invoke(windowId, params);
        if (await vault.exists() && !await unlock(ctx, signal)) return result('Credential fill cancelled.');
        const data = vault.unlocked ? await vault.read() : { mode: 'ask', accounts: [] };
        const accounts = data.accounts.filter(a => a.origin === origin);
        let account = accounts[0];
        if (accounts.length > 1) {
          const choices = accounts.map((a, i) => `${i + 1}. ${localLabel(a.username) || '(no username)'}`);
          const choice = await ctx.ui.select(`Saved accounts for ${origin}`, [...choices, 'Enter a different account'], { signal });
          if (!choice) return result('Credential fill cancelled.');
          account = accounts[choices.indexOf(choice)];
        }
        if (account) {
          if (needsApproval(data.mode, approved, account.id)) {
            const choice = await ctx.ui.select(`Fill ${localLabel(account.username) || 'saved account'} into ${origin}?`, ['Use saved account', 'Enter a different account', 'Cancel'], { signal });
            if (!choice || choice === 'Cancel') return result('Credential fill cancelled.');
            if (choice === 'Enter a different account') account = undefined;
          }
          if (account) credential = { username: account.username, password: account.password };
        }
        let remember = false;
        let savedId: string | undefined;
        if (!credential) {
          const entry = await privatePrompt(ctx, `Verified website: ${origin}\nEnter fills only; it does not submit the form.`,
            ['Username / email (optional on password-only steps)', 'Password'], true, signal);
          if (!entry) return result('Credential fill cancelled.');
          credential = { username: entry.values[0], password: entry.values[1] };
          remember = entry.remember;
          entry.values.fill('');
        }
        if (signal?.aborted) return result('Credential fill cancelled.');
        redactor.remember(credential.password);
        if (remember) {
          if (!await unlock(ctx, signal)) return result('Credential fill cancelled; nothing saved or filled.');
          if (signal?.aborted) return result('Credential fill cancelled.');
          savedId = await vault.save(origin, credential.username, credential.password);
        }
        await browser.invoke(windowId, params, credential);
        if (account || savedId) approved.add(account?.id ?? savedId!);
        return result('Credentials filled privately. No form was submitted.');
      } catch (error) {
        // Only extension-owned errors reach the local UI; never return browser/crypto exceptions to the model.
        ctx.ui.notify(redactor.text(error instanceof Error ? error.message : 'Private credential operation failed.'), 'error');
        return { ...result('Credential fill failed. Ask the user to check the local credential dialog/configuration; no secret is included in this result.'), isError: true };
      } finally {
        browser?.close();
        if (credential) { credential.username = ''; credential.password = ''; }
      }
    },
  }));

  pi.registerCommand('credentials', {
    description: 'Private credential bank: unlock, lock, delete accounts, and approval settings',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('Use an interactive Pi terminal for credentials.', 'error'); return; }
      if (args.trim() === 'lock') { lock(); ctx.ui.notify('Vault locked; session approvals and output redaction memory cleared.', 'info'); return; }
      try {
        const action = await ctx.ui.select('Private credentials', ['Unlock / manage accounts', 'Approval settings', 'Lock']);
        if (!action) return;
        if (action === 'Lock') { lock(); return; }
        if (!await unlock(ctx)) return;
        if (action === 'Approval settings') {
          const choices = ['ask — confirm every saved fill (default)', 'session — approve each saved account once per session', 'yolo — always allow saved fills'];
          const choice = await ctx.ui.select('Reuse policy (saved credentials only)', choices);
          if (!choice) return;
          const mode = MODES[choices.indexOf(choice)];
          if (mode !== 'ask' && !await ctx.ui.confirm('Reduce credential approval?', 'A website prompt can trigger saved fills without a new confirmation. Exact-origin checks still apply.')) return;
          await vault.mutate(data => { data.mode = mode; });
          approved.clear();
          ctx.ui.notify(`Saved credential approval: ${mode}`, 'info');
          return;
        }
        const data = await vault.read();
        if (!data.accounts.length) { ctx.ui.notify('Vault unlocked. No remembered accounts yet.', 'info'); return; }
        const choices = data.accounts.map((a, i) => `${i + 1}. ${a.origin} — ${localLabel(a.username) || '(no username)'}`);
        const choice = await ctx.ui.select('Choose an account to forget (passwords are never displayed)', choices);
        if (!choice) return;
        const id = data.accounts[choices.indexOf(choice)].id;
        if (await ctx.ui.confirm('Forget this account?', 'Deletes it from the vault, not browser cookies or backups.')) {
          await vault.mutate(data => { data.accounts = data.accounts.filter(a => a.id !== id); });
          approved.delete(id);
          ctx.ui.notify('Saved account deleted.', 'info');
        }
      } catch {
        ctx.ui.notify('Credential bank operation failed. Check the master passphrase, vault permissions, and whether another Pi session is writing.', 'error');
      }
    },
  });
}

function localLabel(value: string) { return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100); }
function result(text: string) { return { content: [{ type: 'text' as const, text }], details: undefined }; }
