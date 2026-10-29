# Publishing Dogear on Google Play

Everything you need is in this folder. The steps below are in the order Play Console asks for them.

## 0. Before you start

- A Google Play developer account: https://play.google.com/console. One-time fee (25 USD). Identity verification can take a few days.
- **Personal accounts created after November 2023 cannot publish straight to production.** You must first run a closed test with at least 12 testers opted in for 14 days, then apply for production access. Plan for that. An organisation account skips this.
- The upload file is `../app-release-bundle.aab` (also copied here as `Dogear-1.0.aab`).

## 1. Create the app

Play Console → Create app.
- App name: Dogear
- Default language: English (United States)
- App or game: App
- Free or paid: Free
- Tick the declarations, Create app.

## 2. Set up your app (Dashboard → "Set up your app")

Answer each item like this:

| Item | Answer |
|---|---|
| Privacy policy | `https://hogantara.github.io/dogear/privacy.html` |
| App access | All functionality is available without special access. (Drive sign-in is optional, not required to use the app.) |
| Ads | No, my app does not contain ads |
| Content rating | Start questionnaire. Email: yours. Category: Utility, Productivity, Communication or Other. Answer No to every question. You get "Everyone". |
| Target audience | 18 and over (simplest; avoids the family policy). Not designed for children. |
| News app | No |
| COVID-19 contact tracing | No |
| Data safety | See section 3 |
| Government apps | No |
| Financial features | No financial features |
| Health | No health features |

## 3. Data safety form

Dogear has no server and collects nothing for the developer. Drive sync is optional and writes only to the user's own Drive.

- Does your app collect or share any of the required user data types? **No.**
  (Reason: no data is sent to the developer or a third party on the app's behalf. The user's reactions and notes go to the user's own Google Drive only when the user connects it, under the user's own account. If a reviewer pushes back, switch to Yes and declare: Data type "Files and docs" and "Other user-generated content", Collected: no, Shared: no, Processed ephemerally: no, Purpose: App functionality, Optional: yes, Encrypted in transit: yes, Deletion: user can request deletion, by disconnecting and deleting the Drive folder.)
- Is all of the user data collected by your app encrypted in transit? Yes.
- Do you provide a way for users to request that their data is deleted? Yes (remove books in the app, delete the Dogear folder in Drive).

## 4. Store listing (Grow → Store presence → Main store listing)

Copy from `listing.md`. Graphics from this folder:
- App icon: `icon-512.png`
- Feature graphic: `feature-1024x500.png`
- Phone screenshots: `screenshots/1-shelf.png` to `5-type.png`, upload in that order.

Tablet screenshots are optional. Skip them.

## 5. Upload the bundle

Testing → Closed testing → Create track (or Production if your account is allowed).
- Create new release.
- **Play App Signing**: keep it on (it is the default). Google holds the app signing key; your `android.keystore` becomes the upload key.
- Upload `Dogear-1.0.aab`.
- Release name: 1.0 (1). Release notes: from `listing.md`.
- Next, Save, then Send for review / Start rollout.

## 6. After the first upload: fix the fingerprint (important)

With Play App Signing, Google re-signs the app with its own key. Android then checks that key against the site, so the site must list Google's fingerprint too, or the app opens with a browser bar on top.

1. Play Console → Test and release → Setup → **App signing** (older UI: App integrity).
2. Copy the **SHA-256 certificate fingerprint** under "App signing key certificate".
3. Paste it to me, or add it yourself to `dogear/.well-known/assetlinks.json` as a second entry in `sha256_cert_fingerprints`, keeping the existing one. Push.

Keep the existing fingerprint: it is the upload key, and the sideloaded APK uses it.

## 7. Closed test (personal accounts)

- Testing → Closed testing → Testers: create an email list, add at least 12 people, or use a Google Group.
- Share the opt-in link. Testers must install and keep the app for 14 days.
- After 14 days: Dashboard → Apply for production access. Answer the short questionnaire. Approval usually takes a few days.

## 8. Updating later

1. Push site changes as usual. The app shows them without a new build.
2. For a new app build: bump `appVersionCode` (2, 3, ...) and `appVersion` in `../twa-manifest.json`, run `bubblewrap update --skipVersionUpgrade` then `bubblewrap build --skipPwaValidation` (see README), upload the new AAB to the same track.
3. Never lose `../android.keystore` and `../signing.txt`. With Play App Signing you can request an upload key reset if you do, but it is a support ticket.
