# pebble-jira-sync

An app to sync Jira to Pebble.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` for the phone-oriented status ordering view and `http://localhost:3000/watch.html` for the watch-oriented status change view.

## Secure Jira connection

- Jira credentials stay on the server behind a server-side session with a HttpOnly cookie.
- Jira base URLs must use HTTPS in production. Plain HTTP is only accepted for localhost during local development and tests.

## Test

```bash
npm test
```
