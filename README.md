# Pi Private Credentials

A Pi TUI extension that lets the agent request named form fields **without putting entered values in tool arguments/results**, then privately fills the same Chrome browser used by Chrome DevTools MCP. Supports username/password forms, username-only steps, verification codes, and other text fields.

**Security scope:** prevent routine model/transcript exposure. This is not a sandbox or protection against an agent, extension, website, or local user deliberately stealing secrets. See [SECURITY.md](SECURITY.md) before using real credentials.

## Install

Requires Node.js 22.6+, current `@earendil-works/pi-coding-agent`, interactive Pi TUI, and a local Chrome DevTools MCP browser. Windows additionally requires Windows PowerShell and a filesystem supporting Windows ACLs (such as NTFS). Not compatible with Telegram, print mode, or RPC credential dialogs.

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

Run `/reload` or restart Pi after installing/configuring. Version 0.2.1 uses `.ts` helpers so Pi refreshes the whole extension on reload; earlier `.mjs` helpers could remain cached even after the tool schema updated. An already-running browser must restart with the new flags. Navigate with Chrome MCP once before requesting credentials: MCP starts its browser lazily.

The extension reads the actual ephemeral port from that profile's `DevToolsActivePort` file. If your server name/configuration differs, or you use a project-level override, set `PI_CREDENTIALS_CHROME_PROFILE` to the absolute profile directory before starting Pi. The default discovery reads only the user-level `chrome-devtools` configuration.

## Use

Ask the agent to sign in to a website. It should:

1. Navigate normally using Chrome MCP.
2. Locate the login inputs, without reading their values.
3. Call `secure_fill_credentials` with the exact HTTPS origin and field metadata: label, CSS selector, terminal visibility, and whether the value is temporary.
4. Wait for your private TUI entry/approval.
5. Continue navigating after the fill; **the extension does not click Submit**.

Example model-facing arguments (no entered values):

```json
{
  "origin": "https://example.com",
  "fields": [
    { "label": "Account ID", "selector": "input[name=account]", "hidden": false, "temporary": false },
    { "label": "Verification code", "selector": "input[name=code]", "hidden": true, "temporary": true }
  ]
}
```

- `label`: the field name shown to you, not its value.
- `selector`: a unique visible text-like input or textarea in the top-level document.
- `hidden`: show `****` in the private terminal dialog when true; normal visible typing when false. Actual password inputs require true. Visible entry is still local, not returned in tool results.
- `temporary`: never save or reuse this value. Always true for verification codes and one-time data. False means **eligible** for saving, not permission to save automatically.

Requests support 1–12 uniquely named/selected fields. Each requested field needs a nonempty value. Dialogs display one focused field at a time; Tab cycles through every field and the review step. Entry is single-line, including when the target is a textarea. Checkboxes, dropdowns, file uploads, and other non-text controls are not secret-entry fields; use ordinary browser tools for those.

Existing calls remain compatible (do not combine this format with `fields`):

```json
{
  "origin": "https://example.com",
  "usernameSelector": "input[name=email]",
  "passwordSelector": "input[type=password]"
}
```

### Private terminal UI

The dialogs follow the installed RPIV question/todo design language: an **inline editor-slot panel**, accent-colored horizontal rules, a compact badge, muted tree context, highlighted field tabs, completion markers, numbered approval choices, and dim keyboard hints. They use Pi's active theme, not hard-coded colors or an RPIV runtime dependency. If another overlay is open, the private panel stacks visibly above it instead of taking input underneath it.

Legacy username/password dialogs mask both fields; flexible dialogs follow each field's `hidden` flag and clearly show temporary/storage status. Review shows field names and completion status **without redisplaying any entered value**, including visible entries.

- **Enter** validates the current field and advances to the next field or review. It never fills straight from a field editor.
- **Tab / Shift+Tab** switches between fields and review.
- On review, **↑/↓** selects Remember, the explicit **Fill fields** / **Unlock vault** / **Create vault** action, or Cancel. **Space** toggles Remember only when its checkbox is selected; it starts off. **Enter** on that checkbox moves to the action without toggling consent.
- **Enter** on the final action confirms the private operation. **Esc / Ctrl+C** cancels and clears entry buffers.
- Approval and management menus use **↑/↓**, **Enter**, and type-to-filter; destructive confirmations default to **Cancel**.

Arrow keys, Home/End, Backspace/Delete, Ctrl+A/E/U, Unicode, and bracketed paste remain supported inside fields. A paste containing control characters is rejected rather than silently changing your password. Layouts keep the focused editor/control inside the terminal row budget; terminals too small to show the verified context safely request a resize and refuse blind entry. Never type credentials into the ordinary chat editor.

### Remember

Remember is **off by default**. With Remember enabled, reusable values are saved in the encrypted vault, scoped to the exact scheme + hostname + port. Temporary fields are excluded, even in mixed requests. All-temporary requests show no Remember checkbox, never unlock/read the vault, and never reuse saved values.

Flexible-form storage keeps **one value per exact origin + label + selector + hidden flag**. Remembering a new value explicitly replaces that matching entry. Changing the label, selector, visibility, or origin prevents automatic matching. Saved fields follow the same ask/session/yolo approval policy; missing/temporary fields are entered privately alongside approved saved fields. `/credentials` lets you delete individual remembered fields.

Legacy username/password accounts are retained unchanged. Saving the same username at the same origin replaces that saved password; multiple legacy accounts can be selected locally. Generic field entries and legacy accounts are separate, so the flexible tool does not silently reinterpret old account passwords as other fields.

On first save, choose and repeat a strong master passphrase (minimum 12 characters; a long random passphrase is better). Existing vaults ask for this passphrase after locking/restarting. **The master passphrase is never saved; there is no recovery if you forget it.**

Without Remember, a new value is not available for autofill reuse. Used **hidden** values, including temporary codes, retain an in-memory copy for best-effort output redaction until locking/session shutdown, not for lookup or vault persistence. Visible-field values are not redacted from unrelated website/tool output; see the security limitations below.

### Credential bank and approval settings

Run `/credentials`:

- **Unlock / manage saved entries** — unlock, select a remembered account or field, and confirm deletion. Never displays secret values.
- **Approval settings** — choose a saved-credential reuse policy.
- **Lock**, or `/credentials lock` — drop the vault encryption key, session approvals, and output-redaction references.

| Mode | Remembered-credential behavior |
| --- | --- |
| `ask` (default) | Confirm every saved fill; can enter fresh values instead. |
| `session` | Approve each saved account/field once per session; a newly entered remembered value counts as approved. |
| `yolo` | No reuse confirmation after vault unlock. |

Reduced-approval modes require your confirmation when changing settings. These preferences are stored **inside the encrypted vault**. They never supply credentials that were not remembered. Reusable-field requests against a locked vault still require private master-passphrase entry in every mode. All-temporary requests do not require vault access.

There must be **exactly one tab at the requested origin**. Close duplicate tabs first. Wrong origins, ambiguous/hidden/disabled controls, unmasked password inputs, non-text controls, and cross-origin form actions are rejected. Legacy password targets must still be password inputs. The origin and each input are rechecked immediately before writing; native setters and events are sequenced per field to survive controlled-form rerenders. The final values are compared internally with the requested values, without returning them, so a form that discards them reports failure instead of false success.

## Storage

Default location:

```text
~/.pi/agent/private-credentials/vault.json
```

With a custom Pi agent directory, the vault follows it. Nothing is stored in session entries or in this Git repository.

- AES-256-GCM authenticated encryption; random nonce per write.
- scrypt master-key derivation: N=32768, r=8, p=1, random 16-byte salt.
- Usernames, passwords, generic field values and metadata, origins, and reuse policy are all encrypted. Temporary fields are never persisted.
- Linux/macOS: directory permissions 0700, vault permissions 0600; unsafe permissions and symlinks are refused.
- Windows: new vault directories get a protected, current-user-only ACL inherited by vault files. Existing directories/files must be owned by the current user and grant access only to that user, SYSTEM, or Administrators; broad ACLs and reparse points (including junctions) are refused, never silently repaired. Paths with spaces or Unicode are supported. Windows mode bits are not used as a security check.
- Exclusive writer lock; fresh disk reads, temporary file + fsync + atomic rename to avoid partial writes/lost updates between ordinary sessions. Directory fsync is retained on Linux/macOS; Windows does not support it through Node, so sudden power loss has a weaker durability guarantee after rename.

Back up the encrypted vault if needed. Account deletion is not secure erasure of filesystem history or backups. Locking does not sign out websites, clear browser fields, or erase cookies. If a process crashes while writing, remove `private-credentials/write.lock` **only after stopping all Pi writers**. Do not reset/delete your vault as an unlock troubleshooting step.

## Why not call MCP `fill` internally?

Pi records **nested tool arguments**, even when a nested tool's result is not sent to the model. Passing a password through `ctx.executeTool()` would therefore expose it in session storage.

This extension uses a private loopback Chrome DevTools WebSocket connection and passes secrets directly as CDP function arguments. They are absent from its model-facing tool arguments, results, details, messages, and session entries. Chrome MCP still handles ordinary navigation.

Used hidden values (and legacy passwords) are also filtered from final tool-result text, details, and structured content, including exact, JSON-escaped, and URL-encoded variants. **This filter is best-effort**, not a universal data-loss prevention system. It does not sanitize images, arbitrary encodings, browser/MCP logs, extension event listeners, or every other output channel. Usernames may become visible through ordinary website snapshots after filling.

## Development and checks

```sh
# Host peer packages need to be available for standalone Node tests.
npm ci --ignore-scripts
npm test
```

[CI](.github/workflows/ci.yml) runs these installation and test commands on
Node.js 22 on Linux and Windows for pushes to `main` and pull requests, without real credentials or
browser profiles. `package-lock.json` fixes the standalone test dependency set;
Pi still supplies its own host peers when loading the extension. The optional
real-Chrome check below is not part of CI.

The tests cover encryption, authentication/tampering, permissions, multi-writer updates, origin/field checks, controlled-form rerenders, visible/masked rendering, Unicode/paste handling, cancellation, reuse policies, redaction, legacy compatibility, temporary-field non-storage/non-reuse, secret-free refusal reasons, Pi-style helper reloads, themed inline/review layouts, focused scrolling, overlay stacking, resize protection, and approval-menu cancellation. Refusals now identify the actual failed check; page-generated exception strings remain suppressed.

An optional real-Chrome integration check uses **random disposable test credentials** and a temporary self-signed HTTPS page:

```sh
PI_CREDENTIALS_TEST_PUPPETEER=/absolute/path/to/module-exporting-puppeteer.js \
PI_CREDENTIALS_TEST_CHROME=/path/to/chrome \
node --experimental-strip-types test/live.mjs
```

The Chrome MCP distribution's `build/src/third_party/index.js` exports Puppeteer and can be used for this check. `openssl` is required. The test-only browser ignores its temporary certificate error; the production extension does not add any certificate bypass flags. The check simulates TUI key entry and drives a real browser; it is not a human terminal usability test.

## Current limits

- Local Chrome and interactive Pi terminal only. Linux/macOS require POSIX private permissions; Windows requires Windows PowerShell and ACL support. Existing unsafe vault permissions are refused rather than automatically changed.
- Top-level text-like inputs and single-line textarea entry only. No iframe/shadow-root traversal, multiline entry, non-text widgets, OTP generation, or automatic submission. Verification-code entry is supported, but this is not an authenticator app.
- Native input setters and input/change events cover standard and many framework forms; some sites require custom typing behavior.
- No master-passphrase rotation/import/export UI yet.
- Unrestricted browser/shell tools can still intentionally extract credentials or authenticated session data. Keep `ask` mode unless you understand the additional prompt-injection risk.
