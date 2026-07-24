# Bid-Out mailer - Exchange Application Access Policy runbook

How IT locks the Bid-Out mailer so it can only send mail as a defined set of Broadway mailboxes.
This is the `ApplicationAccessPolicy` step referenced in `api/send-bid/index.js` (see the header
comment, lines 38-43).

## Background - what sends the mail

`api/send-bid` sends each RFP email via Microsoft Graph **app-only** (client-credentials) from the
coordinator's own mailbox. It picks its Graph app registration in this order
(`api/send-bid/index.js:288-289`):

- `BID_CLIENT_ID` / `BID_CLIENT_SECRET` - a dedicated Bid-Out app, if one was created. **Wins if set.**
- else `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` - the existing SWA sign-in app
  (`ac6e325a-0412-48c4-876a-d945eb7f9ecd`), reused. Requires an admin to add the application
  `Mail.Send` permission and grant consent.

App-only `Mail.Send` can, by default, send as ANY mailbox in the tenant. The Application Access
Policy narrows that to a named group. This is defense-in-depth on top of the function's own
`from` allowlist (`BID_FROM_ALLOWED` / `BID_FROM_DOMAIN`).

## Why `New-ApplicationAccessPolicy` "is not recognized"

It is not a built-in PowerShell command. It ships with the `ExchangeOnlineManagement` module and
only loads AFTER `Connect-ExchangeOnline`. If the module is not installed, or you have not
connected, PowerShell cannot find the cmdlet. This works on PowerShell 7 on Linux/macOS as well as
Windows.

## Steps

Run as an account holding an Exchange Administrator or Global Administrator role.

```powershell
# 1. Install the module (once per machine). Add -Force -AllowClobber if prompted.
Install-Module ExchangeOnlineManagement -Scope CurrentUser

# 2. Connect. On a headless box (e.g. a Linux shell) use device-code auth.
Connect-ExchangeOnline -Device

# 3. Confirm the scope group is a MAIL-ENABLED SECURITY GROUP.
#    Application Access Policies reject distribution lists and Microsoft 365 groups.
Get-Recipient rfp-bidders@broadwaynational.com | fl Name,RecipientTypeDetails,PrimarySmtpAddress
#    RecipientTypeDetails must read: MailUniversalSecurityGroup

# 4. Confirm the AppId matches the app that ACTUALLY sends (see Background):
#    - BID_CLIENT_ID set in SWA app settings  -> use that GUID
#    - otherwise (reuse path)                 -> ac6e325a-0412-48c4-876a-d945eb7f9ecd

# 5. Create the policy.
New-ApplicationAccessPolicy -AppId <sending-app-guid> `
  -PolicyScopeGroupId rfp-bidders@broadwaynational.com `
  -AccessRight RestrictAccess `
  -Description "Bid-Out mailer: only bid senders"

# 6. Test both directions. Allow up to ~30 minutes for the policy to propagate.
Test-ApplicationAccessPolicy -Identity acoordinator@broadwaynational.com -AppId <sending-app-guid>  # Granted
Test-ApplicationAccessPolicy -Identity notabidder@broadwaynational.com  -AppId <sending-app-guid>  # Denied
```

## Gotchas

- **AppId must be the sender.** If a dedicated `BID_CLIENT_ID` app exists, the policy on
  `ac6e325a...` does nothing - scope the dedicated app's GUID instead. If both paths are ever
  live, each AppId needs its own policy.
- **RestrictAccess is an intersection.** The app can send only as group members. The function
  separately limits `from` to `BID_FROM_ALLOWED` / `BID_FROM_DOMAIN`. A coordinator must satisfy
  BOTH to send; someone not in `rfp-bidders` gets a Graph 403 at send time even if their address
  is on the domain allowlist. Keep the group in sync with who should be sending bids.
- **App-only only.** Application Access Policies constrain app-only Graph calls; they do not affect
  interactive user sign-in. That matches how `send-bid` works (client credentials), so this is the
  right control.
- **Group type.** Only a mail-enabled security group works for `-PolicyScopeGroupId`. A plain
  security group, distribution list, or M365 group will fail or not scope as expected.
- Microsoft is steering new work toward RBAC for Applications as the longer-term successor;
  `New-ApplicationAccessPolicy` remains supported and is the approach IT started with here.
