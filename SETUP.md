# Stride Log: one-time server setup (Cloudflare, free)

About 15 minutes, on any computer or your phone's browser. Nothing to install, and no card needed.

## 1. Cloudflare account
1. Sign up free at dash.cloudflare.com.
2. In the left menu open **Workers & Pages**. If it asks you to choose a **workers.dev subdomain**, pick one (for example `kevin-runs`) and confirm.
3. On that page, copy your **Account ID** (right-hand side, or under the ⋯ menu next to your account name).

## 2. Cloudflare API token (lets GitHub deploy the server for you)
1. Open **My Profile → API Tokens → Create Token**.
2. Next to **Edit Cloudflare Workers**, click **Use template**.
3. Under **Permissions**, click **+ Add more** and add: **Account → D1 → Edit**.
4. Under **Account Resources**, choose your account. Under **Zone Resources**, choose **All zones**.
5. Click **Continue to summary → Create Token** and copy the token. It's shown only once.

## 3. Anthropic key (for reading screenshots)
At console.anthropic.com: **Billing → add $5 credit**, then **API keys → Create key**, and copy it.

## 4. Put the four values in GitHub (they stay private there)
Open github.com/kevinandrin7-start/stride-log → **Settings → Secrets and variables → Actions → New repository secret**, and add these one at a time:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1 |
| `ANTHROPIC_API_KEY` | the key from step 3 |
| `APP_PASSWORD` | a password you make up, used to sign in to the app |

Don't send any of these to me.

## 5. Turn on the website
In the same repo: **Settings → Pages**. Set Source to **Deploy from a branch**, Branch to **main**, folder **/ (root)**, then **Save**.

## 6. Tell me you're done
I'll start the deploy and check it worked. After that, on your iPhone:
- Open **https://kevinandrin7-start.github.io/stride-log/** in Safari, tap **Share → Add to Home Screen**, and open it from the new icon.
- Sign in with your `APP_PASSWORD`.
- Go to **More → Turn on reminders** and pick a time.
- Go to **More → Copy Shortcut link**, then change your Shortcut (below).

## Changing the nightly Shortcut
In the Shortcuts app, open **Stride Log Daily**:
1. Delete the **Send Email** step.
2. Add **Get Contents of URL** at the end. Paste the Shortcut link as the URL, tap **Show More**, set Method to **POST**, Request Body to **File**, and choose the **Text** from the step above.
3. Run it once by hand. Today's steps and heart rate should show up in the app.
