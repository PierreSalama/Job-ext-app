# The Indeed problem — 10-minute A/B on Dad's Firefox

**Symptom:** while applying on Indeed, the whole tab flashes white, comes back after a moment,
and sometimes Indeed says **"Something went wrong"** with a *Save draft* option mid-application.
Retrying sometimes works, sometimes repeats the error.

**What we suspect (in order):**
1. **Firefox's Total Cookie Protection.** Indeed's apply flow runs on a *different site*
   (`smartapply.indeed.com`) than the job page (`ca.indeed.com`). Firefox's default privacy
   wall separates the two — mid-apply, the apply flow can lose its login, which looks exactly
   like this (white reload → "something went wrong" → retry sometimes works).
2. **Our extension interfering** (it watches every page). The A/B below rules this in or out in 2 minutes.
3. Another extension (ad-blocker etc.) or an unstable connection.

## Step A — is it our extension? (2 min)

1. In Firefox: `about:addons` → find **Job Application Tracker v11** → toggle it **OFF**.
2. Go to Indeed, apply to any job the normal way.
3. **If the white flash / error still happens → it is NOT our extension.** Go to Step B.
   **If it stops happening →** toggle the extension back ON, try once more, and note the result
   either way in `diagnostics/notes.txt` on this USB. (Then still do Step B — both can be true.)
4. Toggle the extension back **ON** when done.

## Step B — the likely fix: cookie exception for Indeed (3 min)

1. In Firefox, open the job site: `https://ca.indeed.com`
2. Click the **shield icon** left of the address bar → turn **Enhanced Tracking Protection OFF
   for this site** (the toggle in that panel).
3. Do the same on `https://smartapply.indeed.com` if a page from it is ever visible.
4. Apply to a job again. **If the error is gone → we're done; leave the shield off for Indeed.**

## Step C — if it STILL happens (5 min)

1. Press **F12** (opens developer tools) → click the **Console** tab → leave it open.
2. Reproduce the error (apply until the white flash / "something went wrong" appears).
3. In the Console: right-click any line → **Select all** → copy → paste into a new file
   `diagnostics/indeed-console.txt` on this USB (Notepad: paste, save).
4. Also note in `diagnostics/notes.txt`:
   - Was the extension ON or OFF when it happened?
   - Roughly how far into the application (first page? after uploading resume? at submit?)
   - Does he use any other Firefox add-ons? (`about:addons` — list their names)
5. Bring the USB back to Pierre.

## Why this order

Step A splits the world in half instantly (ours vs not-ours). Step B is the most likely
one-click fix for a cross-site login break. Step C captures the actual error if the easy
answers miss, so the next fix is aimed at evidence instead of guesses.
