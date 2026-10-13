# Security boundary

## Intended protection

Private TUI input plus direct CDP filling keeps entered values out of this extension's model-facing arguments/results and ordinary Pi session records. The agent supplies field names/selectors/visibility/temporary flags, not values. Remembered data is authenticated-encrypted on disk with a user-entered master passphrase. Exact-origin and field checks prevent accidental fills on different origins and into inappropriate elements. Temporary fields are never persisted or used for saved-value lookup; non-temporary fields require explicit user Remember consent before saving. Password inputs must be masked. The RPIV-style UI still uses its own no-history private editor rather than Pi/RPIV's ordinary editor. Review renders completion status, never entered values; Remember stays off until explicitly toggled. Inline entry falls back to a visible stacked overlay when necessary and blocks entry on terminals too small to show the verified context safely.

This assumes trusted Pi, trusted installed extensions, trusted OS/browser/MCP, and a legitimate login page. It is not a security boundary against a malicious agent with unrestricted tools.

## What is not protected

- Chrome must receive the plaintext. The receiving website can read/exfiltrate credentials; exact-origin checks do not make a compromised site safe.
- An agent/local process with shell/CDP access can read password fields, inspect memory, intercept browser requests, or steal cookies. Loopback debugging endpoints are unauthenticated local capabilities. Never expose the port beyond the host or use a personal browser profile.
- Other Pi extensions can inspect terminal input and tool events. Do not install untrusted extensions alongside this one.
- Final tool-result redaction only covers known exact/JSON/URL-encoded strings. It does not protect screenshots, arbitrary transformations/encodings, streaming events, internal browser/MCP logging, or hostile extension hooks. Do not inspect authentication request bodies or filled values. Debug logging/tracing can leak secrets.
- Locking clears references and zeroes the derived key buffer, but JavaScript strings, runtime copies, OS swap, crash dumps, and browser memory cannot be reliably zeroized. Used hidden values (including temporary codes) are kept in memory for best-effort redaction until lock/shutdown, even when Remember is off. This is not autofill reuse. Fields requested with hidden:false are visible in your terminal and are not filtered from unrelated website/tool output. After lock the redactor no longer protects lingering browser values.
- Existing browser profiles retain authenticated cookies/sessions. Locking/deleting a vault account does not clear them or invalidate server sessions.
- Weak master passphrases can be guessed offline. A forgotten master passphrase cannot be recovered.
- `session` and `yolo` modes let prompts trigger approved/saved fills without per-fill user scrutiny. Exact-origin checks still apply; flexible saved fields also match the exact label, selector, and visibility. These are accidental-misrouting checks, not authorization against a malicious agent that can request known metadata. A same-origin malicious page or inappropriate same-origin workflow can misuse credentials. `ask` is the default.
- Multi-session storage uses a lock and fresh reads, not a database. Malicious local file replacement or filesystem rollback remains outside scope. There is no secure deletion of backups or automatic stale-lock recovery.

## For hostile-agent protection

Use a separate credential broker/browser process with an OS-enforced permission boundary and restricted browser operations. Remove unrestricted shell, evaluation, network-inspection, and DOM-read capabilities from the agent. A TUI extension alone cannot supply that guarantee.

## Reporting

For a secret-handling vulnerability, contact the repository owner privately rather than posting real credentials or vault data in an issue. Include only synthetic reproductions. Do not use production passwords to test this extension.
