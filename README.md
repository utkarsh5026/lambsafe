# LambSafe

A Chrome extension that keeps a copy of your AWS Lambda code **before** you change it in the AWS console.

When you edit a function in the Lambda console's code editor and deploy, the previous code is gone: `$LATEST` is overwritten and AWS keeps no history of it. LambSafe downloads the deployed version as a `.zip` before you change it. It downloads each version **only once**, so editing, re-opening a function or pressing Deploy repeatedly never creates duplicate downloads.

## How it works

1. **It notices that you are about to change a function.** On a function page in the Lambda console it watches for:
   - **starting to edit**: typing, pasting, or clicking into the code editor
   - **deploying**: the *Deploy* button or `Ctrl/Cmd+Shift+U`
   - **uploading**: *Upload from → .zip file / Amazon S3 location*, which also replaces the code
2. **It asks AWS which version is live.** It calls [`lambda:GetFunction`](https://docs.aws.amazon.com/lambda/latest/api/API_GetFunction.html), which returns the code's `CodeSha256` hash and a short-lived download link.
3. **It downloads only versions it has never saved.** If that hash has been saved before, nothing is downloaded. If not, the zip goes to
   `Downloads/LambSafe/<account>/<region>/<function>/<function>_<deployed-at>_<sha8>.zip`.

Because the check starts when you *start editing*, the backup is already on disk well before you can press Deploy. The Deploy check runs again as a safety net, in case someone else deployed in the meantime. LambSafe never blocks or changes the console. If anything goes wrong you can still deploy, and a toast tells you what happened.

### When does it download?

| Situation | AWS call | Download |
|---|---|---|
| You open a function and start typing, and this version isn't saved yet | yes | **yes** |
| You keep typing | no (checks again after 10 min) | no |
| You press Deploy and the live version is already saved | yes | no |
| Your deploy went live and you edit again (or deploy again) | yes | **yes**, the newly live version |
| You roll back to code identical to an older saved version | yes | no (same hash) |
| You deleted the backup file from disk | yes | **yes**, again |
| You only open a function to read it | no | no (unless you turn on "As soon as a function opens") |

## Gaps in the original idea, and how they're handled

- **Timing.** A download that starts *after* you press Deploy races against the deploy and can capture the new code instead of the old one. LambSafe starts the backup when you begin editing, long before Deploy.
- **"Already downloaded" has to mean the same code.** Versions are compared by Lambda's `CodeSha256`, not by time or file name. That covers identical re-deploys, rollbacks and double-clicks. If a backup file was deleted, it is downloaded again.
- **You need AWS credentials.** An extension can't reuse the console's own login to call AWS APIs. LambSafe needs an access key that is allowed to call `lambda:GetFunction` and nothing else (policy below).
- **Several AWS accounts.** Functions with the same name can exist in several accounts. LambSafe reads the console's account from the multi-session URL or from the function ARN on the page. It only uses credentials for that same account, and never backs up a same-named function from a different account.
- **Deploys you didn't make in the editor.** *Upload from .zip / S3* replaces code too, so it triggers a check. Teammates deploying from CI are caught by the Deploy check and the periodic re-check.
- **The editor is an iframe.** If the extension can't run inside the editor frame, it still notices when focus moves into the editor.
- **Things that aren't a zip.** Container-image functions have no zip to save, so LambSafe says so and skips them. Published versions and aliases are read-only in AWS, so they're ignored.

## Install

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension/` folder.
3. The settings page opens. Add AWS credentials (see below).
4. Open a function in the Lambda console and start editing. A LambSafe toast confirms the backup.

To build a zip for the Chrome Web Store or for sharing, run `npm run package`. The zip lands in `dist/lambsafe.zip`.

## AWS credentials

Create an IAM user (or a role you get temporary credentials for) with only this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:GetFunction",
      "Resource": "arn:aws:lambda:*:*:function:*"
    }
  ]
}
```

In LambSafe settings, paste the access key ID and secret. For SSO or other temporary credentials, also paste the session token. LambSafe verifies them with STS `GetCallerIdentity`, which needs no permissions, to learn which account they belong to. Add one set per AWS account you work in. When temporary credentials expire, save fresh ones for the same account and they replace the old ones.

Credentials are stored in `chrome.storage.local` on this machine only. They are not synced, and they are sent only to AWS API endpoints. The storage is not encrypted, the same as `~/.aws/credentials`, which is one more reason to use a key that can only read function code.

## Using it

- **Toasts** on the console page report *Backing up…*, *Saved*, *Already backed up* and errors. You can turn them off in settings.
- **Toolbar badge:** `✓` means the live version of this function is saved, `…` means a download is running, `!` means something failed.
- **Popup:** shows the current function's saved versions and recent backups across all functions. It has **Back up now**, **Download again** and **Show** (reveals the file).
- **Settings:** credentials, which triggers are on, the re-check interval, the download folder, and **Forget download history** (next check downloads again; files on disk are kept).

## What it does not cover

- Only the function **code** of `$LATEST` is saved, not configuration, environment variables, layers or triggers.
- It recognises the Deploy button by its label. If AWS renames it, the edit/focus trigger and the re-check while editing still cover you. It reads the open function from the console URL. If AWS changes the URL format, LambSafe needs an update.
- Backups appear in Chrome's download list like any other download. If Chrome is set to ask where to save every file, you may be asked for backups too.
- Standard AWS partition consoles (`*.console.aws.amazon.com`) only.

## Development

No build step: the `extension/` folder is loaded as is. Plain JavaScript modules, no runtime dependencies.

```
extension/
  manifest.json
  background.js          service worker: routes page signals, badge, toasts
  content/content.js     runs in console frames: detects edit / deploy / upload
  lib/
    backup.js            dedupe + download logic (unit tested)
    aws.js, sigv4.js     GetFunction / GetCallerIdentity with SigV4 signing
    console-url.js       console URL → region / function / account
    paths.js, settings.js
  popup/, options/, ui/  toolbar popup and settings page
test/                    unit tests (node --test)
e2e/run.js               browser test against a fake console + fake AWS
```

```sh
npm install        # only needed for the e2e test (Playwright)
npm test           # unit tests; the SigV4 signer is checked against botocore's output
npm run test:e2e   # loads the extension in Chromium; needs openssl; screenshots in e2e/output/
npm run check      # syntax + manifest/HTML reference checks
```

`scripts/make_icons.py` regenerates the icons (needs Pillow).
