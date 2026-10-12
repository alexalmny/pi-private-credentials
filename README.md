# Pi Private Credentials

A Pi TUI extension that lets the agent request website credentials **without putting passwords in the conversation**, then privately fills the same Chrome browser used by Chrome DevTools MCP.

**Security scope:** prevent routine model/transcript exposure. This is not a sandbox or protection against an agent, extension, website, or local user deliberately stealing secrets. See [SECURITY.md](SECURITY.md) before using real credentials.

## Install

Requires Node.js 22+, current `@earendil-works/pi-coding-agent`, interactive Pi TUI, and a local Chrome DevTools MCP browser. Not compatible with Telegram, print mode, or RPC credential dialogs.

```sh
# Private repository: your git client needs GitHub access.
pi install git:github.com/alexalmny/pi-private-credentials
```

For development / immediate local iteration:

```sh
git clone git@github.com:alexalmny/pi-private-credentials.git
pi install ./pi-private-credentials
```

No runtime dependencies beyond Node.js and Pi's host packages.

## Configure the shared Chrome browser

Append these arguments to the `chrome-devtools` server in `~/.pi/agent/mcp.json`:

```json
"--chromeArg=--remote-debugging-port=0",
"--chromeArg=--remote-debugging-address=127.0.0.1"
```

Keep an explicit `--userDataDir` in the same argument list, for example:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y", "chrome-devtools-mcp@latest",
        "--headless",
        "--userDataDir", "/absolute/path/to/chrome-profile",
        "--no-usage-statistics",
        "--chromeArg=--remote-debugging-port=0",
        "--chromeArg=--remote-debugging-address=127.0.0.1"
      ],
      "exposure": "deferred"
    }
  }
}
```

Retain any existing platform-specific flags (`--executablePath`, viewport, etc.). Use a **dedicated browser profile**, not your personal desktop profile. Do not publish/forward the debugging port.

Run `/reload` or restart Pi after installing/configuring. An already-running browser must restart with the new flags. Navigate with Chrome MCP once before requesting credentials: MCP starts its browser lazily.

The extension reads the actual ephemeral port from that profile's `DevToolsActivePort` file. If your server name/configuration differs, or you use a project-level override, set `PI_CREDENTIALS_CHROME_PROFILE` to the absolute profile directory before starting Pi. The default discovery reads only the user-level `chrome-devtools` configuration.

## Use

Ask the agent to sign in to a website. It should:

1. Navigate normally using Chrome MCP.
2. Locate the login inputs, without reading their values.
3. Call `secure_fill_credentials` with only the exact HTTPS origin and CSS selectors.
4. Wait for your private TUI entry/approval.
5. Continue navigating after the fill; **the extension does not click Submit**.

Example model-facing arguments (no credential values):

```json
{
  "origin": "https://example.com",
  "usernameSelector": "input[name=email]",
  "passwordSelector": "input[type=password]"
}
```

The dialog masks both username and password. **Tab / Shift+Tab** changes fields; **Space** toggles Remember when its checkbox is focused; **Enter** approves entry and filling; **Esc** cancels. Arrow keys, Home/End, Backspace/Delete, Ctrl+A/E/U, Unicode, and bracketed paste are supported. A paste containing control characters is rejected rather than silently changing your password. Never type credentials into the ordinary chat editor.

### Remember

Remember is **off by default**. With Remember enabled, the account is saved in the encrypted vault, scoped to the exact scheme + hostname + port. Saving the same username at the same origin replaces that saved password. Multiple accounts can be selected locally; usernames are not listed to the model by this extension.

On first save, choose and repeat a strong master passphrase (minimum 12 characters; a long random passphrase is better). Existing vaults ask for this passphrase after locking/restarting. **The master passphrase is never saved; there is no recovery if you forget it.**

Without Remember, the credential is not available for autofill reuse. A temporary copy of used passwords is retained for output redaction until locking/session shutdown; see the security limitations below.

### Credential bank and approval settings

Run `/credentials`:

- **Unlock / manage accounts** — unlock, select a remembered account, and confirm deletion. Never displays passwords.
- **Approval settings** — choose a saved-credential reuse policy.
- **Lock**, or `/credentials lock` — drop the vault encryption key, session approvals, and output-redaction references.

| Mode | Remembered-credential behavior |
| --- | --- |
| `ask` (default) | Confirm every saved fill; can choose a different account instead. |
| `session` | Approve each saved account once per session; a newly entered remembered credential counts as approved. |
| `yolo` | No reuse confirmation after vault unlock. |

Reduced-approval modes require your confirmation when changing settings. These preferences are stored **inside the encrypted vault**. They never supply credentials that were not remembered. A locked vault still requires private master-passphrase entry in every mode.

There must be **exactly one tab at the requested origin**. Close duplicate tabs first. Wrong origins, ambiguous/hidden/disabled inputs, non-password password targets, and cross-origin form actions are rejected. The origin and inputs are checked again immediately before filling.

## Storage

Default location:

```text
~/.pi/agent/private-credentials/vault.json
```

With a custom Pi agent directory, the vault follows it. Nothing is stored in session entries or in this Git repository.

- AES-256-GCM authenticated encryption; random nonce per write.
- scrypt master-key derivation: N=32768, r=8, p=1, random 16-byte salt.
- Username, origin, password, and reuse policy are all encrypted.
- Directory permissions 0700, vault permissions 0600; unsafe permissions and vault symlinks are refused.
- Exclusive writer lock; fresh disk reads, temporary file + fsync + atomic rename to avoid partial writes/lost updates between ordinary sessions.

Back up the encrypted vault if needed. Account deletion is not secure erasure of filesystem history or backups. Locking does not sign out websites, clear browser fields, or erase cookies. If a process crashes while writing, remove `private-credentials/write.lock` **only after stopping all Pi writers**. Do not reset/delete your vault as an unlock troubleshooting step.

## Why not call MCP `fill` internally?

Pi records **nested tool arguments**, even when a nested tool's result is not sent to the model. Passing a password through `ctx.executeTool()` would therefore expose it in session storage.

This extension uses a private loopback Chrome DevTools WebSocket connection and passes secrets directly as CDP function arguments. They are absent from its model-facing tool arguments, results, details, messages, and session entries. Chrome MCP still handles ordinary navigation.

Used passwords are also filtered from final tool-result text, details, and structured content, including exact, JSON-escaped, and URL-encoded variants. **This filter is best-effort**, not a universal data-loss prevention system. It does not sanitize images, arbitrary encodings, browser/MCP logs, extension event listeners, or every other output channel. Usernames may become visible through ordinary website snapshots after filling.

## Development and checks

```sh
# Host peer packages need to be available for standalone Node tests.
npm install --ignore-scripts
npm test
```

The tests cover encryption, authentication/tampering, permissions, multi-writer updates, origin/field checks, controlled-form rerenders, private rendering, Unicode/paste handling, cancellation, reuse policies, and redaction.

An optional real-Chrome integration check uses **random disposable test credentials** and a temporary self-signed HTTPS page:

```sh
PI_CREDENTIALS_TEST_PUPPETEER=/absolute/path/to/module-exporting-puppeteer.js \
PI_CREDENTIALS_TEST_CHROME=/path/to/chrome \
node --experimental-strip-types test/live.mjs
```

The Chrome MCP distribution's `build/src/third_party/index.js` exports Puppeteer and can be used for this check. `openssl` is required. The test-only browser ignores its temporary certificate error; the production extension does not add any certificate bypass flags. The check simulates TUI key entry and drives a real browser; it is not a human terminal usability test.

## Current limits

- Local Chrome, Linux/macOS-style private file permissions, and interactive Pi terminal only.
- Top-level username+password and password-only forms. No iframe/shadow-root traversal, username-only first-step tool, arbitrary secret fields, OTP manager, or automatic submission.
- Native input setters and input/change events cover standard and many framework forms; some sites require custom typing behavior.
- No master-passphrase rotation/import/export UI yet.
- Unrestricted browser/shell tools can still intentionally extract credentials or authenticated session data. Keep `ask` mode unless you understand the additional prompt-injection risk.
