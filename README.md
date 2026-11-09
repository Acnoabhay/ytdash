# Acnoabhay YouTube Creator Studio

A self-hosted dashboard for **@acnoabhay** with:
- Public channel statistics from YouTube Data API v3.
- Private channel analytics after Google OAuth consent.
- Latest uploads and their public view/like/comment counts.
- 28-day daily views, estimated watch time, subscriber gains/losses.
- Daily history snapshots stored locally on the server.
- Automatic refresh every 5 minutes while the dashboard is open.
- Encrypted OAuth token storage (AES-256-GCM) on the backend.

## Important accuracy note
YouTube's public subscriber count is rounded by YouTube. Analytics reports can be delayed. The watch-hours total in this dashboard is `estimatedMinutesWatched / 60` for the last 28 complete reporting days. It is **not** the official YPP-valid public watch-hours counter. Check the Earn tab in YouTube Studio for official eligibility.

## Requirements
- Node.js 20+
- A Google Cloud project
- YouTube Data API v3 and YouTube Analytics API enabled

## Google Cloud setup
1. Open https://console.cloud.google.com/ and create/select a project.
2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
3. Create an API key. Restrict it to YouTube Data API v3 and set it as `YOUTUBE_API_KEY`.
4. Configure the OAuth consent screen. Add your Google account as a test user while the app is in Testing.
5. Create an OAuth Client ID of type **Web application**.
6. Add this Authorized redirect URI exactly: `http://localhost:3000/auth/google/callback`
7. Copy the client ID and client secret into `.env`.

## Configure and run
```bash
npm install
cp .env.example .env
```
Generate encryption/session secrets:
```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex')); console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex'))"
```
Paste those values into `.env`, along with your API key, OAuth client ID and secret.

Start with `npm start`, then open http://localhost:3000. Public data uses the API key; click **Connect Google** to authorize private Studio analytics. Use the Google account that owns the @acnoabhay channel.

## Deploying
Deploy the Node app to a host that supports persistent environment variables and persistent disk/storage. Set `NODE_ENV=production`, use HTTPS, and update `GOOGLE_REDIRECT_URI` plus the OAuth Authorized redirect URI to `https://YOUR-DOMAIN/auth/google/callback`. Use persistent storage for `data/google-token.enc` and `data/history.json`.

## Security
- Never commit `.env`, OAuth client secrets, or `data/google-token.enc`.
- Never paste Google passwords, access tokens, refresh tokens, or client secrets into chat.
- OAuth scopes are read-only: `youtube.readonly` and `yt-analytics.readonly`.
- The included in-memory Express session store is intended for a single-user prototype; use a durable session store and add CSRF/rate-limit protections before wider production use.
