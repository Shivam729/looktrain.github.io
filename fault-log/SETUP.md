# Fault Log — Google Sheet sync setup

The Fault Log page (`faults.html`) saves entries on each device, then syncs them
to **one private Google Sheet** so your phone and work laptop share the same list.
You do the Google part once (about 5 minutes), then paste two values into each device.

## 1. Create the sheet

1. Go to <https://sheets.new> (signed in to your Google account).
2. Name it something like **Fault Log**.

## 2. Add the sync script

1. In the sheet: **Extensions → Apps Script**.
2. Delete everything in `Code.gs` and paste in the contents of
   [`fault-log/Code.gs`](Code.gs) from this repo.
3. On the line `const SECRET = 'CHANGE-ME-...'`, replace the text in quotes with your
   own long passphrase (e.g. four random words). **Don't** commit this anywhere.
4. Click **Save** (disk icon).

## 3. Deploy it as a web app

1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**.
4. Click **Deploy**, then **Authorize access** and pick your account.
   Google will warn the app isn't verified — it's your own script, so click
   **Advanced → Go to (project name) (unsafe) → Allow**.
5. Copy the **Web app URL** (ends in `/exec`).

"Anyone" only means the URL can be reached; every request must also carry your
passphrase, and the data lives in your private sheet. Keep the URL and passphrase to yourself.

## 4. Connect each device

On your phone **and** your work laptop:

1. Open <https://shivam729.github.io/looktrain.github.io/faults.html> (or the Fault Log link on the depot lookup page).
2. Open **Sync & backup settings** at the bottom.
3. Paste the Web app URL and your passphrase → **Save & sync**.
4. The status line should turn green: "Synced · …".

On the phone, use **Add to Home Screen** so it opens like an app.

## How it behaves

- **Offline:** entries save on the device and show "Not synced". They upload
  automatically when you're back online (or tap **Sync now**).
- **Edits on two devices:** the most recent save wins.
- **Delete** removes the entry on every device (it stays as a row marked `deleted = TRUE` in the sheet).
- **The sheet** is your master list — you can sort, filter or print it in Google Sheets.
  Edit entries through the site, though; the site doesn't pick up edits typed straight into the sheet.
- **Backup:** Export backup / Import backup in settings saves or merges a `.json` file, no Google needed.

## Changing the script later

If you edit `Code.gs`, redeploy with **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
The URL stays the same.
