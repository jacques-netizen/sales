/**
 * Google Calendar poller — Calendly-flavored event detector
 *
 * Every minute, fetches upcoming events from a Google Calendar and looks for
 * ones that look like Calendly bookings. An event counts ONLY if it contains:
 *   - a calendly.com link in the description, AND
 *   - the phrase "powered by calendly" (case-insensitive)
 *
 * This filter prevents the bot from acting on random meetings on the calendar.
 *
 * Two state changes are reported to the bot:
 *   - new event spotted → onNewBooking(parsedEvent)
 *   - tracked event disappeared (cancellation) → onCancellation(parsedEvent)
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import fs from 'fs';

const CALENDLY_FINGERPRINT = /powered by calendly/i;
const CALENDLY_URL = /https?:\/\/(?:[\w-]+\.)?calendly\.com\/[^\s)>"']+/i;

function parseCalendlyEvent(event) {
  const desc = event.description ?? '';
  const summary = event.summary ?? 'Calendly Booking';

  // Extract invitee name: Calendly description always includes
  // "Invitee: <Name>" or summary like "Discovery Call with <Name>"
  let inviteeName = null;
  const inviteeMatch = desc.match(/Invitee\s*[:\-]\s*(.+?)(?:\r|\n|<)/i);
  if (inviteeMatch) inviteeName = inviteeMatch[1].trim();
  if (!inviteeName) {
    const withMatch = summary.match(/(?:with|w\/)\s+(.+)$/i);
    if (withMatch) inviteeName = withMatch[1].trim();
  }
  if (!inviteeName) inviteeName = summary;

  // Extract invitee email
  const emailMatch = desc.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const inviteeEmail = emailMatch ? emailMatch[0] : '';

  // Calendly link
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
  serviceAccountKeyPath,
  calendarId,
  pollSeconds = 60,
  onNewBooking,
  onCancellation,
}) {
  if (!fs.existsSync(serviceAccountKeyPath)) {
    console.warn(`[calendar] Service account key not found at ${serviceAccountKeyPath}. Calendar poller disabled.`);
    return { stop: () => {} };
  }

  const key = JSON.parse(fs.readFileSync(serviceAccountKeyPath, 'utf8'));
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  // In-memory store of events we've already seen.
  // Map<eventId, parsedEvent>
  const seen = new Map();
  let primed = false; // first sweep just snapshots existing events without firing onNewBooking

  async function sweep() {
    try {
      const now = new Date();
      const timeMax = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days ahead
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
          // Keep latest snapshot in case fields change
          seen.set(event.id, parsed);
        }
      }

      // Detect disappearances (cancellations / deletions)
      if (primed) {
        for (const [eventId, parsed] of seen.entries()) {
          if (!currentIds.has(eventId)) {
            // Only count as cancellation if the event was in the future
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
        console.log(`[calendar] Primed with ${seen.size} existing Calendly events. Now watching for new bookings.`);
      }
    } catch (err) {
      console.error('[calendar] sweep failed:', err.message);
    }
  }

  // Run once immediately to prime, then on interval
  sweep();
  const interval = setInterval(sweep, pollSeconds * 1000);

  return { stop: () => clearInterval(interval) };
}
