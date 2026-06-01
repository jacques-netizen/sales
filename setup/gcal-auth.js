/**
 * Run this ONCE to authorise the bot to read your Google Calendar.
 * It opens a URL in the terminal — paste it into your browser, log in,
 * copy the code Google gives you, paste it back here. Done.
 *
 * Usage: npm run gcal-auth
 */

import { makeOAuth2Client } from '../bot/calendar.js';
import readline from 'readline';
import fs from 'fs';
import 'dotenv/config';

const TOKEN_PATH = './google-oauth-token.json';

const oAuth2Client = makeOAuth2Client();

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  prompt: 'consent', // forces refresh_token to be returned
});

console.log('\n─────────────────────────────────────────────────────');
console.log('Step 1: Open this URL in your browser and log in with');
console.log('        the Google account that has the calendar:');
console.log('\n' + authUrl + '\n');
console.log('Step 2: Google will show you a code. Copy it.');
console.log('─────────────────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here and press Enter: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Token saved to google-oauth-token.json');
    console.log('   You can now run: npm run bot');
  } catch (err) {
    console.error('\n✗ Failed to exchange code:', err.message);
    console.error('  Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in .env');
  }
});
