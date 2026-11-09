import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
// Windows mode bits do not describe access: check SID-based ACLs instead.
const script = `
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_VAULT_ACL_PATH))
$item = Get-Item -LiteralPath $p -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
if ($env:PI_VAULT_ACL_CREATE -eq '1') {
  # Elevated Windows tokens may default new objects to the Administrators owner.
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'Allow')
  }
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
  $acl = Get-Acl -LiteralPath $p
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'Wrong owner' }
$allowed = @($me.Value, 'S-1-5-18', 'S-1-5-32-544')
$ownAccess = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -notin $allowed) { throw 'Untrusted access' }
    if ($rule.IdentityReference.Value -eq $me.Value -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
        ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownAccess = $true }
  }
}
if (-not $ownAccess) { throw 'Missing owner access' }
`;

export async function windowsPrivate(path, create = false) {
  try {
    await run(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, maxBuffer: 16384, env: { ...process.env,
        PI_VAULT_ACL_PATH: Buffer.from(path, 'utf8').toString('base64'), PI_VAULT_ACL_CREATE: create ? '1' : '0' } });
  } catch {
    throw new Error('Unsafe vault permissions: Windows ACL must be owned by you and allow only your account, SYSTEM or Administrators; links are refused.');
  }
}
