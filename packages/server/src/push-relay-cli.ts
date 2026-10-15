// Run the notification relay (operator-controlled; never started by CLAN apps). Put it behind HTTPS (reverse proxy).
//   CLAN_RELAY_PORT=8443 CLAN_RELAY_DB=/var/lib/clan-relay.db
//   CLAN_FCM_SERVICE_ACCOUNT=/secure/firebase-sa.json            (Android)
//   CLAN_APNS_KEY=/secure/AuthKey_XXXX.p8 CLAN_APNS_KEY_ID=XXXX CLAN_APNS_TEAM_ID=YYYY CLAN_APNS_TOPICS=app.bundle.id CLAN_APNS_PRODUCTION=0  (iOS)
//   node packages/server/src/push-relay-cli.ts
import { readFileSync } from 'node:fs';
import { apnsSender, fcmSender, pushRelay } from './push-relay.ts';

const env = process.env;
const fcm = env.CLAN_FCM_SERVICE_ACCOUNT ? fcmSender(JSON.parse(readFileSync(env.CLAN_FCM_SERVICE_ACCOUNT, 'utf8'))) : undefined;
const apns = env.CLAN_APNS_KEY ? apnsSender({ teamId: env.CLAN_APNS_TEAM_ID!, keyId: env.CLAN_APNS_KEY_ID!, privateKey: readFileSync(env.CLAN_APNS_KEY, 'utf8'), production: env.CLAN_APNS_PRODUCTION === '1' }) : undefined;
if (!fcm && !apns) { console.error('Configure CLAN_FCM_SERVICE_ACCOUNT and/or CLAN_APNS_KEY.'); process.exit(1); }
const relay = pushRelay({ dbPath: env.CLAN_RELAY_DB ?? 'clan-relay.db', senders: { fcm, apns }, topics: env.CLAN_APNS_TOPICS?.split(',') });
const port = Number(env.CLAN_RELAY_PORT ?? 8443);
relay.server().listen(port, env.CLAN_RELAY_HOST ?? '127.0.0.1', () => console.log(`CLAN push relay on ${port} (FCM ${fcm ? 'on' : 'off'}, APNs ${apns ? 'on' : 'off'})`));
