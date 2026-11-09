# Changelog

## [0.3.1]

- Prepare the public release with npm metadata and the `pi-package` discovery keyword for the Pi package gallery.
- Restrict npm contents to source, package metadata, and public documentation; exclude tests and CI configuration.
- Document Pi's built-in update notifications and `pi update --extensions` workflow. Include this changelog for Pi's Extension Updates display.
- No changes to credential handling or vault format.

## [0.3.0]

- Support flexible named fields, visible or masked private terminal entry, and temporary values that are never saved or reused.
- Remember reusable fields only with explicit consent in an encrypted, exact-origin-bound vault.
- Add inline private-entry and review panels, controlled-form rerender handling, reloadable TypeScript helpers, and safe refusal diagnostics.
- Support Windows private vault ACLs alongside Linux/macOS permission checks.
- Keep credentials out of model-facing fill arguments/results using direct loopback Chrome DevTools filling, with best-effort hidden-value output redaction.
