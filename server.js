require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { google } = require('googleapis');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'google-token.enc');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(session({
  name: 'acnoabhay.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function configured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY);
}
function oauthClient(redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`) {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
}
function encryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  return Buffer.from(hex, 'hex');
}
function saveTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  const payload = { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload), { mode: 0o600 });
}
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  const p = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(p.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(p.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.data, 'hex')), decipher.final()]).toString('utf8'));
}
function getHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function addSnapshot(snapshot) {
  const history = getHistory();
  const day = new Date().toISOString().slice(0, 10);
  const idx = history.findIndex(x => x.day === day);
  const item = { day, subscribers: snapshot.subscribers ?? null, views: snapshot.views ?? null, watchHours: snapshot.watchHours ?? null };
  if (idx >= 0) history[idx] = item; else history.push(item);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-365), null, 2));
}
async function getPublicChannel() {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('Add YOUTUBE_API_KEY in environment variables to enable public channel statistics.');
  const yt = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
  const response = await yt.channels.list({ part: ['snippet', 'statistics', 'contentDetails'], forHandle: 'acnoabhay', maxResults: 1 });
  const channel = response.data.items?.[0];
  if (!channel) throw new Error('Could not find @acnoabhay. Confirm the handle and API key.');
  return {
    id: channel.id, title: channel.snippet?.title, handle: channel.snippet?.customUrl || '@acnoabhay',
    thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url,
    subscribers: Number(channel.statistics?.subscriberCount || 0), views: Number(channel.statistics?.viewCount || 0),
    videoCount: Number(channel.statistics?.videoCount || 0), hiddenSubscribers: Boolean(channel.statistics?.hiddenSubscriberCount)
  };
}
async function getAuthorizedClient() {
  const tokens = loadTokens();
  if (!tokens) return null;
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on('tokens', fresh => {
    try { saveTokens({ ...tokens, ...fresh }); } catch (e) { console.error('Could not persist refreshed token:', e.message); }
  });
  return client;
}

app.get('/api/status', (req, res) => {
  res.json({ configured: configured(), connected: Boolean(fs.existsSync(TOKEN_FILE)), handle: '@acnoabhay', secureTokenStorage: configured() });
});
app.get('/auth/google', (req, res) => {
  if (!configured()) return res.status(400).send('Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY first.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: SCOPES, state }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('OAuth state check failed. Please restart Google sign-in.');
    delete req.session.oauthState;
    if (req.query.error) return res.status(400).send(`Google authorization was not completed: ${req.query.error}`);
    const { tokens } = await oauthClient().getToken(String(req.query.code));
    saveTokens(tokens);
    res.redirect('/?connected=1');
  } catch (e) { console.error(e); res.status(500).send('Google sign-in failed. Check your OAuth redirect URI and server configuration.'); }
});
app.post('/auth/logout', (req, res) => {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/public', async (req, res) => {
  try {
    const channel = await getPublicChannel();
    addSnapshot({ subscribers: channel.subscribers, views: channel.views });
    res.json({ ...channel, fetchedAt: new Date().toISOString(), source: 'YouTube Data API v3' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/analytics', async (req, res) => {
  try {
    const auth = await getAuthorizedClient();
    if (!auth) return res.status(401).json({ error: 'Connect the Google account that owns @acnoabhay.' });
    const yt = google.youtube({ version: 'v3', auth });
    const mine = await yt.channels.list({ part: ['id', 'snippet', 'statistics'], mine: true, maxResults: 5 });
    const channel = mine.data.items?.[0];
    if (!channel) return res.status(404).json({ error: 'No YouTube channel was found on the authorized Google account.' });
    const end = new Date(); end.setDate(end.getDate() - 2);
    const start = new Date(end); start.setDate(start.getDate() - 27);
    const iso = d => d.toISOString().slice(0, 10);
    const analytics = google.youtubeAnalytics({ version: 'v2', auth });
    const report = await analytics.reports.query({
      ids: 'channel==MINE', startDate: iso(start), endDate: iso(end),
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost',
      dimensions: 'day', sort: 'day'
    });
    const rows = (report.data.rows || []).map(r => ({
      day: r[0], views: Number(r[1] || 0), minutesWatched: Number(r[2] || 0),
      averageViewDuration: Number(r[3] || 0), subscribersGained: Number(r[4] || 0), subscribersLost: Number(r[5] || 0)
    }));
    const totals = rows.reduce((a, r) => ({
      views: a.views + r.views, minutesWatched: a.minutesWatched + r.minutesWatched,
      subscribersGained: a.subscribersGained + r.subscribersGained, subscribersLost: a.subscribersLost + r.subscribersLost
    }), { views: 0, minutesWatched: 0, subscribersGained: 0, subscribersLost: 0 });
    const watchHours = Math.round((totals.minutesWatched / 60) * 10) / 10;
    addSnapshot({ subscribers: Number(channel.statistics?.subscriberCount || 0), views: Number(channel.statistics?.viewCount || 0), watchHours });
    res.json({
      channel: { id: channel.id, title: channel.snippet?.title, thumbnail: channel.snippet?.thumbnails?.default?.url, subscribers: Number(channel.statistics?.subscriberCount || 0), totalViews: Number(channel.statistics?.viewCount || 0) },
      period: { start: iso(start), end: iso(end), label: 'Last 28 complete reporting days' },
      totals: { ...totals, watchHours }, daily: rows, fetchedAt: new Date().toISOString(),
      note: 'Watch hours here are estimated watch time from Analytics, not the exact YPP-valid public watch-hours counter. Analytics data is delayed.'
    });
  } catch (e) { console.error(e); res.status(502).json({ error: e.message || 'Could not retrieve YouTube Analytics.' }); }
});
app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/videos', async (req, res) => {
  try {
    const auth = await getAuthorizedClient();
    if (!auth) return res.status(401).json({ error: 'Connect Google to load your latest uploads.' });
    const yt = google.youtube({ version: 'v3', auth });
    const channel = (await yt.channels.list({ part: ['contentDetails'], mine: true, maxResults: 1 })).data.items?.[0];
    const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return res.json({ items: [] });
    const playlist = await yt.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId: uploads, maxResults: 12 });
    const ids = (playlist.data.items || []).map(x => x.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return res.json({ items: [] });
    const videos = await yt.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: ids });
    res.json({ items: (videos.data.items || []).map(v => ({
      id: v.id, title: v.snippet?.title, thumbnail: v.snippet?.thumbnails?.medium?.url,
      publishedAt: v.snippet?.publishedAt, views: Number(v.statistics?.viewCount || 0),
      likes: Number(v.statistics?.likeCount || 0), comments: Number(v.statistics?.commentCount || 0), url: `https://youtu.be/${v.id}`
    })) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.listen(PORT, () => console.log(`Acnoabhay dashboard running on port ${PORT}`));
