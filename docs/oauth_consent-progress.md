# OAuth consent — progress

**Problem.** Reconnecting a connector that was already approved (Workshop (Surface)) failed with
"authorization request is no longer pending". When the client already had consent,
`getAuthorizationDetails` returned `{ redirect_url }`. The page ignored that, showed the consent card
anyway, and Approve posted `/consent` to a request that was already approved.

## Step 1 — plan (oauth_consent-r7k-s1-m4qz)
Read-only. Confirmed the cause from the auth-js 2.95.3 types: the response is `OAuthAuthorizationDetails | OAuthRedirect`, told apart by `'authorization_id' in data`.

## Step 2 — fix (oauth_consent-r7k-s2-x8dn)
`src/OAuthConsent.jsx`:
- If the response is already consented, the page calls `window.location.replace(redirect_url)` and shows "Redirecting…". There is no card and no approve call.
- The card shows `client.name`, `redirect_uri`, and `scope` split into a list. It used to read `application.name` and `scopes[]`, which do not exist.
- Approve and deny pass `skipBrowserRedirect: true`, then replace to `data.redirect_url`. The code used to read `redirect_to`, which does not exist.
- If approve or deny comes back "no longer pending", the page fetches the details once more. If that returns a redirect, it follows it. Otherwise it shows the expired card: go back to Claude and click Connect again.

`src/OAuthConsent.test.jsx`: 5 tests.

Status: implemented and tested. The build compiles. Not yet deployed.
