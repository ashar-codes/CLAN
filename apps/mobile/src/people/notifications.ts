import { Platform, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { PeopleAlert } from '@clan/core';
import { phoneClan, me } from '../core/clan';
let initialized = false;
let viewing: string | null = null;
let pending: string | null = null;
export const takePeopleChat = () => { const id = pending; pending = null; return id; };
const opens = new Set<(id: string | null) => void>();
export const onPeopleNotification = (cb: (id: string | null) => void) => { opens.add(cb); return () => { opens.delete(cb); }; };
export const setPeopleViewing = (id: string | null) => { viewing = id; };
export async function allowPeopleNotifications() {
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('clan-people', { name: 'CLAN messages and calls', importance: Notifications.AndroidImportance.HIGH, sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  return (await Notifications.requestPermissionsAsync()).granted;
}
export async function peopleNotice(id: string, title: string, convId?: string) {
  const c = phoneClan(), prefs = c.notifications.prefs(me());
  if (!prefs.direct || AppState.currentState === 'active' && viewing && viewing === convId) return;
  const permissions = await Notifications.getPermissionsAsync(); if (!permissions.granted) return;
  await Notifications.scheduleNotificationAsync({ identifier: `people-${id}`, content: { title: prefs.previews ? title : 'CLAN', body: 'Open CLAN to view.', sound: 'default', data: { people: true, convId: convId ?? null } }, trigger: Platform.OS === 'android' ? { channelId: 'clan-people' } : null });
}
export function initializePeopleNotifications() {
  if (initialized) return; initialized = true;
  if (Platform.OS === 'android') void Notifications.setNotificationChannelAsync('clan-people', { name: 'CLAN messages and calls', importance: Notifications.AndroidImportance.HIGH, sound: 'default', lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
  phoneClan().bus.subscribe('mobile.people.alert', PeopleAlert, (e) => {
    const x = e.payload; const prefs = phoneClan().notifications.prefs(me());
    if (x.kind.startsWith('file.') && !prefs.files) return;
    const title = x.kind === 'friend.nearby' ? 'Verified CLAN friend is reachable nearby' : x.kind === 'call.attempt' ? 'Call attempt received after reconnecting (did not ring)' : x.kind === 'call.missed' ? 'Missed CLAN call' : x.kind === 'call.invite' ? 'Incoming CLAN call' : x.kind === 'friend.request' ? 'CLAN friend request' : x.kind === 'file.offer' ? 'CLAN file or voice note' : x.kind === 'file.done' ? 'CLAN transfer complete' : x.kind === 'chat.invite' ? 'CLAN chat invitation' : 'New CLAN message';
    void peopleNotice(x.id, title, x.convId).catch(() => {});
  });
  const opened = (r: Notifications.NotificationResponse | null) => { const data = r?.notification.request.content.data; if (!data?.people) return; const id = data.convId; pending = typeof id === 'string' ? id : null; for (const cb of opens) cb(pending); };
  Notifications.addNotificationResponseReceivedListener(opened);
  void Notifications.getLastNotificationResponseAsync().then(opened).catch(() => {});
}
