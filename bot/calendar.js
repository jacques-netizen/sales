/**
 * Google Calendar poller — Calendly-flavored event detector
 *
 * Auth: OAuth2 with a saved refresh token (no service account key needed).
 * Run `npm run gcal-auth` once to log in via browser and save the token.
 *
 * Every minute, fetches upcoming events and looks for Calendly bookings.
 * An event counts ONLY if it contains:
 *   - a calendly.com link in the description, AND
 *   - the phrase "powered by calendly" (case-insensitive)
 *
 * Two state changes are reported to the bot:
 *   - new event spotted    → onNewBooking(parsedEvent)
 *   - tracked event gone   → onCancellation(parsedEvent)
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const CALENDLY_FINGERPRINT = /powered by calendly/i;
const CALENDLY_URL = /https?:\/\/(?:[\w-]+\.)?calendly\.com\/[^\s)>"']+/i;
const TOKEN_PATH = './google-oauth-token.json';

export function makeOAuth2Client() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob' // out-of-band: user pastes the code
  );
}

export function loadSavedToken(oAuth2Client) {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  // Auto-save refreshed tokens
  oAuth2Client.on('tokens', (tokens) => {
    const current = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
  });
  return true;
}

function parseCalendlyEvent(event) {
  const desc = event.description ?? '';
  const summary = event.summary ?? 'Calendly Booking';

  let inviteeName = null;
  const inviteeMatch = desc.match(/Invitee\s*[:\-]\s*(.+?)(?:\r|\n|<)/i);
  if (inviteeMatch) inviteeName = inviteeMatch[1].trim();
  if (!inviteeName) {
    const withMatch = summary.match(/(?:with|w\/)\s+(.+)$/i);
    if (withMatch) inviteeName = withMatch[1].trim();
  }
  if (!inviteeName) inviteeName = summary;

  const emailMatch = desc.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const inviteeEmail = emailMatch ? emailMatch[0] : '';

  const linkMatch = desc.match(CALENDLY_URL);
  const calendlyLink = linkMatch ? linkMatch[0] : '';

  return {
    eventId: event.id,
    inviteeName,
    inviteeEmail,
    eventName: summary,
    startTime: event.start?.dateTime ?? event.start?.date,
    endTime: event.end?.dateTime ?? event.end?.date,
    calendlyLink,
    htmlLink: event.htmlLink,
  };
}

function looksLikeCalendly(event) {
  const desc = event.description ?? '';
  return CALENDLY_FINGERPRINT.test(desc) && CALENDLY_URL.test(desc);
}

export function startCalendarPoller({
  calendarId = 'primary',
  pollSeconds = 60,
  onNewBooking,
  onCancellation,
}) {
  const oAuth2Client = makeOAuth2Client();
  if (!loadSavedToken(oAuth2Client)) {
    console.warn('[calendar] No OAuth token found. Run `npm run gcal-auth` first. Calendar poller disabled.');
    return { stop: () => {} };
  }

  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
  const seen = new Map();
  let primed = false;

  async function sweep() {
    try {
      const now = new Date();
      const timeMax = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      const res = await calendar.events.list({
        calendarId,
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });

      const events = res.data.items ?? [];
      const currentIds = new Set();

      for (const event of events) {
        if (event.status === 'cancelled') continue;
        if (!looksLikeCalendly(event)) continue;

        currentIds.add(event.id);
        const parsed = parseCalendlyEvent(event);

        if (!seen.has(event.id)) {
          seen.set(event.id, parsed);
          if (primed) {
            await onNewBooking(parsed).catch((e) => console.error('[calendar] onNewBooking:', e));
          }
        } else {
          seen.set(event.id, parsed);
        }
      }

      if (primed) {
        for (const [eventId, parsed] of seen.entries()) {
          if (!currentIds.has(eventId)) {
            const start = new Date(parsed.startTime).getTime();
            if (start > Date.now()) {
              await onCancellation(parsed).catch((e) => console.error('[calendar] onCancellation:', e));
            }
            seen.delete(eventId);
          }
        }
      }

      if (!primed) {
        primed = true;
        console.log(`[calendar] Primed with ${seen.size} existing Calendly events. Watching for new bookings.`);
      }
    } catch (err) {
      console.error('[calendar] sweep failed:', err.message);
    }
  }

  sweep();
  const interval = setInterval(sweep, pollSeconds * 1000);
  return { stop: () => clearInterval(interval) };
}
