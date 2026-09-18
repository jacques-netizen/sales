/**
 * Google Calendar poller — Cal.com booking detector
 *
 * Auth: OAuth2 with a saved refresh token (no service account key needed).
 * Run `npm run gcal-auth` once to log in via browser and save the token.
 *
 * Every minute, fetches upcoming events and looks for Cal.com bookings.
 * An event counts ONLY if its description contains a Cal.com booking-manage
 * link (https://cal.com/booking/<uid>, or your custom domain — see
 * CAL_BOOKING_DOMAIN below). That link is Cal.com's standard "reschedule or
 * cancel" footer, so it's a reliable fingerprint that won't fire on random
 * meetings you put on the calendar by hand.
 *
 * Also extracts utm_source / utm_medium / utm_campaign from the event
 * description (populated via a hidden Cal.com booking question pre-filled
 * from the booking link's query string) so every booking carries its
 * traffic source into Discord.
 *
 * Two state changes are reported to the bot:
 *   - new event spotted    → onNewBooking(parsedEvent)
 *   - tracked event gone   → onCancellation(parsedEvent)
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

// Change via CAL_BOOKING_DOMAIN in .env if you're on a custom/white-labeled Cal.com domain.
const CAL_BOOKING_DOMAIN = process.env.CAL_BOOKING_DOMAIN || 'cal.com';
const CAL_BOOKING_URL = new RegExp(
  `https?:\\/\\/(?:[\\w-]+\\.)?${CAL_BOOKING_DOMAIN.replace(/\./g, '\\.')}\\/booking\\/[\\w-]+`,
  'i'
);
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

// Cal.com writes "undefined" into the description for optional questions
// the booker left blank.
const isBlank = (v) => !v || v.trim() === '' || v.trim().toLowerCase() === 'undefined';

function extractUtm(desc) {
  const utm = {};
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  for (const key of keys) {
    // Cal.com renders each booking question as "<Label>:\n<answer>", using the field's
    // LABEL (not its identifier) — so the label must be the utm_* key for this to match.
    const match = desc.match(new RegExp(`${key}\\s*[:=\\-]\\s*(.+?)(?:\\r|\\n|<)`, 'i'));
    if (match && !isBlank(match[1])) utm[key] = match[1].trim();
  }

  // Fallback: some setups keep the original UTM-tagged link in the description.
  if (!utm.utm_source) {
    const linkMatch = desc.match(/https?:\/\/[^\s)>"']*utm_source=([^\s&)>"']+)/i);
    if (linkMatch) utm.utm_source = decodeURIComponent(linkMatch[1]);
  }

  return utm;
}

function parseCalBooking(event) {
  const desc = event.description ?? '';
  const summary = event.summary ?? 'Cal.com Booking';

  // The attendee list is authoritative for who booked — the description lists the
  // organiser's email first, so scraping it would pick up our own address.
  const invitee = (event.attendees ?? []).find((a) => !a.self && !a.organizer);
  const inviteeEmail = invitee?.email ?? '';

  // Cal.com default title format: "{eventType} between {organiser} and {attendee}"
  let inviteeName = invitee?.displayName ?? null;
  if (!inviteeName) {
    const betweenMatch = summary.match(/\bbetween\s+.+?\s+and\s+(.+)$/i);
    if (betweenMatch) inviteeName = betweenMatch[1].trim();
  }
  if (!inviteeName) {
    const withMatch = summary.match(/(?:with|w\/)\s+(.+)$/i);
    if (withMatch) inviteeName = withMatch[1].trim();
  }
  if (!inviteeName) inviteeName = inviteeEmail || summary;

  const linkMatch = desc.match(CAL_BOOKING_URL);
  const bookingLink = linkMatch ? linkMatch[0] : '';

  const utm = extractUtm(desc);

  return {
    eventId: event.id,
    inviteeName,
    inviteeEmail,
    eventName: summary,
    startTime: event.start?.dateTime ?? event.start?.date,
    endTime: event.end?.dateTime ?? event.end?.date,
    bookingLink,
    htmlLink: event.htmlLink,
    source: utm.utm_source ?? 'Unknown',
    medium: utm.utm_medium ?? null,
    campaign: utm.utm_campaign ?? null,
  };
}

function looksLikeCalBooking(event) {
  const desc = event.description ?? '';
  return CAL_BOOKING_URL.test(desc);
}

export const __test = { parseCalBooking, looksLikeCalBooking, extractUtm };

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
        if (!looksLikeCalBooking(event)) continue;

        currentIds.add(event.id);
        const parsed = parseCalBooking(event);

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
        console.log(`[calendar] Primed with ${seen.size} existing Cal.com bookings. Watching for new bookings.`);
      }
    } catch (err) {
      console.error('[calendar] sweep failed:', err.message);
    }
  }

  sweep();
  const interval = setInterval(sweep, pollSeconds * 1000);
  return { stop: () => clearInterval(interval) };
}
