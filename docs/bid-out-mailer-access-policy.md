# Bid-Out mailer - who can send, and the Exchange guardrail

How the Bid-Out mailer decides which mailboxes may send RFP email, and how the optional Exchange
Application Access Policy relates to it. Grounded in `api/send-bid/index.js`.

## Two layers control "who can send"

1. **Function `from` allowlist (the real, domain-aware control).** `api/send-bid` checks the
   requested `from` address against app settings before it sends (`send-bid/index.js:291-322`):
   - `BID_FROM_ALLOWED` - comma-separated EXACT addresses.
   - `BID_FROM_DOMAIN` - comma-separated whole domains, leading `@` tolerated
     (e.g. `broadwaynational.com` = any mailbox on that domain may send).
   - A send passes if `from` is an exact match in `BID_FROM_ALLOWED` OR its domain is in
     `BID_FROM_DOMAIN`. At least one of the two must be set or the endpoint stays a 503.

2. **Exchange Application Access Policy (optional, coarser, tenant-edge).** Restricts which
   mailboxes the app registration may send as at the Graph layer. **It can only scope to a
   mail-enabled security group** - see the limits below. It is defense-in-depth on top of layer 1,
   not the place a domain-wide rule lives.

## Which app registration sends

`api/send-bid` uses Microsoft Graph app-only (client credentials). It picks credentials in this
order (`send-bid/index.js:288-290`):

- `BID_CLIENT_ID` / `BID_CLIENT_SECRET` - a dedicated Bid-Out app, if created. Wins if set.
- else `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` - the existing SWA sign-in app
  (`ac6e325a-0412-48c4-876a-d945eb7f9ecd`), reused. An admin adds the application `Mail.Send`
  permission and grants consent.

Broadway is on the **reuse path**: the sending app is `ac6e325a-0412-48c4-876a-d945eb7f9ecd`.

## Chosen configuration: anyone @broadwaynational.com may send

"Anyone on the domain" is a layer-1 setting, because an Application Access Policy cannot scope to a
domain (see limits). Steps:

1. In the Function App application settings, per environment:

   ```
   BID_FROM_DOMAIN = broadwaynational.com
   ```

   `BID_FROM_ALLOWED` can be left empty; the check passes on domain OR exact address.

2. Remove any restrictive Application Access Policy on the app so it does not over-narrow the
   domain rule. There is no `Set-` cmdlet to change a policy's scope - remove and (if ever needed)
   recreate:

   ```powershell
   Connect-ExchangeOnline -Device   # from the ExchangeOnlineManagement module; see below

   Get-ApplicationAccessPolicy |
     Where-Object AppId -eq 'ac6e325a-0412-48c4-876a-d945eb7f9ecd' |
     Format-List Identity,AppId,ScopeName,AccessRight,Description

   Remove-ApplicationAccessPolicy -Identity '<Identity-from-above>'
   ```

### What still guards the send after the policy is gone

The Application Access Policy was tenant-edge belt-and-suspenders. Removing it leaves these
controls, all enforced server-side on every request:

- the shared function key (`x-bwn-key` vs `WO_INGEST_KEY`),
- a vouched Umbrava identity - a real, named sender recorded in the audit log,
- the `from`-domain check above (the actual domain boundary),
- recipients BCC-only, capped at `MAX_BCC`; To/Reply-To = the sender,
- HTML active-markup rejection,
- a rolling blob audit log plus a per-day recipient ceiling (`DAILY_RECIPIENTS`).

Removing the policy only affects **app-only** Graph calls by that registration (Bid-Out's
`Mail.Send`). It does NOT affect interactive SWA user sign-in (delegated).

## Application Access Policy limits (why domain-wide is not a policy)

- `-PolicyScopeGroupId` accepts only recipients that are **security principals**: user mailboxes,
  mail users, and **mail-enabled security groups** (nested groups included).
- **Not supported:** dynamic distribution groups, regular distribution groups, Microsoft 365
  Groups, shared/resource/discovery mailboxes, mail contacts. A dynamic distribution group is not
  a security principal, so it cannot be used - which is why "everyone on the domain automatically"
  is not expressible as a policy scope.
- Consequence: the only way to keep a Graph-layer restriction is a static mail-enabled security
  group with hand-maintained membership. That is the right tool for a fixed SUBSET of senders, not
  for a whole domain. For a whole domain, use `BID_FROM_DOMAIN` and skip the policy.
- Reference (source note): the code comment at `send-bid/index.js:43` describes scoping with "a
  dynamic security group of the same domain users" - that is not achievable, since dynamic groups
  are not valid policy scopes. Treat `BID_FROM_DOMAIN` as the domain control.

## If you instead want a fixed subset (kept for reference)

Only if the requirement changes to a specific list of senders. Requires an Exchange/Global admin.

```powershell
# The cmdlets below live in the ExchangeOnlineManagement module and load only after connecting -
# this is why "New-ApplicationAccessPolicy is not recognized" until you Connect-ExchangeOnline.
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once per machine
Connect-ExchangeOnline -Device                               # device-code auth on a headless box

# The scope group MUST be a mail-enabled security group:
Get-Recipient <group>@broadwaynational.com | fl Name,RecipientTypeDetails,PrimarySmtpAddress
#   RecipientTypeDetails must read: MailUniversalSecurityGroup

New-ApplicationAccessPolicy -AppId ac6e325a-0412-48c4-876a-d945eb7f9ecd `
  -PolicyScopeGroupId <group>@broadwaynational.com `
  -AccessRight RestrictAccess `
  -Description "Bid-Out mailer: only bid senders"

# RestrictAccess is an INTERSECTION with the function's from-check: a sender must satisfy both.
# A coordinator not in the group gets a Graph 403 even if their address is on the domain.
Test-ApplicationAccessPolicy -Identity someone@broadwaynational.com -AppId ac6e325a-0412-48c4-876a-d945eb7f9ecd
# Allow up to ~30 minutes for the policy to propagate.
```
