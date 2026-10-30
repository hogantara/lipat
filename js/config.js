// Deployment defaults. A web OAuth client ID is public by design (it is sent to the browser anyway);
// the client restricts which origins may use it. Override per device in Settings if you like.
export const GOOGLE_CLIENT_ID = '538424666196-3b160rpt9fjih29k2oq3dk1fufdm54sh.apps.googleusercontent.com';
// Browser API key for the Google Picker ("Add from Google Drive"). Create it in the same Cloud project as the
// client ID, restrict it to the Picker API and to https://hogantara.github.io/*. Empty hides the Drive option.
export const GOOGLE_API_KEY = '';
