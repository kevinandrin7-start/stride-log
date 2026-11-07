# Stride Log: setting up the server (Supabase)

You do this once, on a computer if you can (your wife's Mac works). It takes about 15 minutes.

## 1. Create the project
1. Go to supabase.com, sign up (free), and click **New project**.
2. Name it `stride-log`, choose a database password (save it somewhere), pick the region **East US**, and click **Create**.
3. When it's ready, click **Connect** at the top (or open **Project Settings → API Keys**) and copy two things:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **Publishable key** (starts with `sb_publishable_`). Older projects call it the **anon public** key (starts with `eyJ`). Either one works.
   - Never send the **secret** or **service_role** key.
4. Send me both. They are safe to share, because the app's code is public and these keys only work for a signed-in user's own data.

## 2. Create the database
1. In the left menu, open **SQL Editor → New query**.
2. Paste in all of `supabase/schema.sql` and click **Run**. You should see "Success. No rows returned".

## 3. Add your Anthropic key (private, don't send it to me)
1. At console.anthropic.com: open **Settings → Billing** and add $5 of credit. Then open **API keys → Create key** and copy it.
2. In Supabase, open **Edge Functions → Secrets → Add new secret**.
   - Name: `ANTHROPIC_API_KEY`
   - Value: paste the key
3. Save it.

## 4. Create the server function
1. In Supabase, open **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `api`.
3. Delete the sample code, paste in all of `supabase/functions/api/index.ts`, and click **Deploy**.
4. Open the function's **Settings** (or Details) and turn **Enforce JWT verification OFF**, then save. The function checks your sign-in itself, and your iPhone Shortcut needs to reach it without signing in.

## 5. Turn on reminders
1. Open **SQL Editor → New query** again.
2. Paste `supabase/cron.sql`, replace `PROJECT_REF` with the part of your Project URL before `.supabase.co`, and click **Run**.

## 6. Tell me you're done
I'll test the server, put the link in the app, and send you your github.io address. Then you'll:
- Open the link in Safari, tap **Share → Add to Home Screen**, and open it from the icon.
- Create your account in the app with your email and a password, then tap the confirmation email.
- Go to **More → Turn on reminders** and pick your reminder time.
- Go to **More → Copy Shortcut link**, and change your Shortcut as below.

## Changing the nightly Shortcut
In the Shortcuts app, open **Stride Log Daily**:
1. Delete the **Send Email** step.
2. Add **Get Contents of URL** at the end. Paste the Shortcut link as the URL, tap **Show More**, set Method to **POST**, Request Body to **File**, and choose the **Text** step from above as the file.
3. Run it once by hand. Today's steps and heart rate should show up on the app's Today screen.

When that works, tell me and I'll turn off the old email import.
