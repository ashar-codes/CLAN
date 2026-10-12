// The phone shell: Home · Study · Inbox · Diary · Me, a bottom bar with large targets, and the CLAN room look
// (wall, wood, the student's CLANmate). Joining a live CLAN opens the existing pinned-TLS join flow.
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { dataNotice, phoneClan, me } from './core/clan';
import { nearby } from './people/nearby';
import { syncNow } from './sync/phone';
import { cleanupClanCopy } from './clan-lifecycle';
import { StudyScreen, type MobileStudyTab } from './screens/Study';
import { InboxScreen } from './screens/Inbox';
import { DiaryScreen } from './screens/Diary';
import { DevicesScreen } from './screens/Devices';
import { HostingScreen } from './screens/Hosting';
import { PeopleScreen } from './screens/People';
import { onPeopleNotification } from './people/notifications';
import { phonePeople } from './people/native';
import { act, bump, Btn, Card, Field, Mate, Muted, RoomBand, Row, Screen, useC, useData, when } from './ui/kit';

type Tab = 'home' | 'study' | 'people' | 'inbox' | 'diary' | 'me';
const TABS: [Tab, string, string][] = [['home', 'Home', '⌂'], ['study', 'Study', '✎'], ['people', 'People', '☻'], ['inbox', 'Inbox', '⇣'], ['diary', 'Diary', '❦'], ['me', 'Me', '☺']];

export function Shell({ join, onEditProfile, intake }: { join: ReactNode; onEditProfile(): void; intake?: ReactNode }) {
  const c = useC();
  const [tab, setTab] = useState<Tab>('home'), [joining, setJoining] = useState(false), [devices, setDevices] = useState(false), [hosting, setHosting] = useState(false);
  useEffect(() => onPeopleNotification(() => { setTab('people'); setJoining(false); setDevices(false); setHosting(false); }), []);
  const [studyInitial, setStudyInitial] = useState<MobileStudyTab>('courses');
  const inboxCount = useData(() => phoneClan().capture.inbox(me()).length) ?? 0;
  // Known contacts reconnect on launch; optional Android availability is restored only after foreground consent.
  useEffect(() => { try { if (phoneClan().people.contacts('all').length || nearby.mode === 'keep') void phonePeople().catch(() => {}); } catch { /* CLAN not open yet */ } }, []);
  const peopleCount = useData(() => phoneClan().people.conversations().reduce((n, x) => n + x.unread + (x.state === 'invited_in' ? 1 : 0), 0) + phoneClan().people.contacts('requests').filter((r) => r.relation === 'incoming').length) ?? 0;
  const body = intake ?? (joining ? <Screen><Btn label="← Back" onPress={() => setJoining(false)} />{join}</Screen>
    : tab === 'home' ? <Home onCreate={() => { setTab('me'); setHosting(true); }} onJoin={() => setJoining(true)} go={setTab} onStudy={(t) => { setStudyInitial(t); setTab('study'); }} />
    : tab === 'study' ? <StudyScreen initial={studyInitial} /> : tab === 'people' ? <PeopleScreen onJoin={() => setJoining(true)} /> : tab === 'inbox' ? <InboxScreen /> : tab === 'diary' ? <DiaryScreen />
    : devices ? <View style={{ flex: 1 }}><DevicesScreen /><View style={{ position: 'absolute', top: 12, right: 16 }}><Btn small label="Done" onPress={() => setDevices(false)} /></View></View>
    : hosting ? <View style={{ flex: 1 }}><HostingScreen /><View style={{ position: 'absolute', top: 12, right: 16 }}><Btn small label="Done" onPress={() => setHosting(false)} /></View></View>
    : <MeScreen onDevices={() => setDevices(true)} onHosting={() => setHosting(true)} onEditProfile={onEditProfile} />);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1 }}>{body}</View>
      {!intake && (
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface }}>
          {TABS.map(([t, l, ic]) => (
            <Pressable key={t} accessibilityRole="tab" accessibilityLabel={t === 'inbox' && inboxCount ? `${l}, ${inboxCount} items` : t === 'people' && peopleCount ? `${l}, ${peopleCount} new` : l} accessibilityState={{ selected: tab === t }}
              onPress={() => { setTab(t); setJoining(false); setDevices(false); setHosting(false); }} style={{ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 18, color: tab === t ? c.text : c.muted }}>{ic}</Text>
              <Text style={{ fontSize: 12, fontWeight: tab === t ? '800' : '500', color: tab === t ? c.text : c.muted }}>{l}{t === 'inbox' && inboxCount ? ` · ${inboxCount}` : t === 'people' && peopleCount ? ` · ${peopleCount}` : ''}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Home({ onCreate, onJoin, go, onStudy }: { onCreate(): void; onJoin(): void; go(t: Tab): void; onStudy(t: MobileStudyTab): void }) {
  const c = useC();
  const name = useData(() => phoneClan().identity.displayName(phoneClan().me)) ?? 'Me';
  const today = useData(() => phoneClan().agenda.today(me())) ?? [];
  const session = useData(() => phoneClan().study.active(me()));
  const linked = useData(() => (phoneClan().sync.selfRevoked() ? 0 : phoneClan().sync.devices().filter((d) => !d.current && !d.revoked).length)) ?? 0;
  const objects = [
    { title: 'Desk', hint: session ? 'Study in progress' : 'Begin a study session', run: () => onStudy('session'), color: c.study, glyph: '▱' },
    { title: 'Backpack', hint: 'Open Inbox', run: () => go('inbox'), color: c.warn, glyph: '▣' },
    { title: 'Bookshelf', hint: 'Courses and notes', run: () => onStudy('courses'), color: c.burgundy, glyph: '▥' },
    { title: 'Journal', hint: 'Private Diary', run: () => go('diary'), color: c.ok, glyph: '▤' },
    { title: 'Semester board', hint: 'Tasks and deadlines', run: () => onStudy('tasks'), color: c.study, glyph: '▦' },
    { title: 'Guide', hint: 'Ask CLAN', run: () => onStudy('ask'), color: c.ai, glyph: '✦' },
    { title: 'Commons entrance', hint: 'Find and join a CLAN', run: onJoin, color: c.ok, glyph: '⌂' },
  ];
  return (
    <Screen>
      {!!dataNotice() && <Card tone="warn"><Text accessibilityRole="alert" style={{ color: c.text }}>{dataNotice()}</Text></Card>}
      <RoomBand title={`${name.split(' ')[0]}'s desk`} sub={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} right={<Mate name={name} size={52} />} />
      <Row><Btn label="Create CLAN" onPress={onCreate} /><Btn primary label="Join a CLAN" onPress={onJoin} /><Btn label={session ? 'Studying…' : 'Start studying'} onPress={() => onStudy('session')} /><Btn label="Capture" onPress={() => go('inbox')} /></Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }} accessibilityLabel="My Space objects">
        {objects.map(({ title, hint, run, color, glyph }) => <Pressable key={title} accessibilityRole="button" accessibilityLabel={`${title}: ${hint}`} onPress={run} style={({ pressed }) => ({ width: '47%', minHeight: 104, padding: 14, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.bg2 : c.surface })}>
          <Text accessible={false} style={{ color, fontSize: 30 }}>{glyph}</Text><Text style={{ color: c.text, fontWeight: '800', fontSize: 16 }}>{title}</Text><Text style={{ color: c.text2, fontSize: 12 }}>{hint}</Text>
        </Pressable>)}
      </View>
      <LocalClans />
      <Card title="Today" tone="study">
        {today.length === 0 && <Muted>Nothing due today.</Muted>}
        {today.map((i) => (
          <View key={i.kind + i.id}>
            <Text style={{ color: i.overdue ? c.danger : c.text, fontWeight: '600' }}>{i.title}</Text>
            <Muted small>{i.source}{i.at ? ` · ${when(i.at)}` : ''}</Muted>
          </View>
        ))}
      </Card>
      <Muted small>{linked ? `Synced with ${linked} of your device${linked === 1 ? '' : 's'} when on the same Wi-Fi.` : 'This phone isn’t linked to your computer yet (Me › My Devices).'}</Muted>
    </Screen>
  );
}

function LocalClans() {
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const active = useData(() => phoneClan().clans.list(phoneClan().me)) ?? [];
  const archived = useData(() => phoneClan().clans.list(phoneClan().me, { archived: true })) ?? [];
  const copies = useData(() => phoneClan().clans.storedCopies(phoneClan().me)) ?? [];
  const pending = useData(() => phoneClan().clans.pendingCleanup(phoneClan().me)) ?? [];
  if (!copies.length && !pending.length && !notice && !err) return null;
  const change = (id: string, on: boolean) => setErr(act(() => phoneClan().clans.setLocalArchive(id, phoneClan().me, on)));
  const run = async (id: string, kind: 'remove' | 'delete') => {
    setBusy(id); setErr(null); setNotice('');
    try { const result = await cleanupClanCopy(id, kind); setNotice(`Cleanup finished. ${result.retained} modified or shared copies retained.`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); bump(); }
  };
  const remove = (clan: (typeof copies)[number]) => Alert.alert(clan.mine ? 'Delete CLAN from this phone?' : 'Remove CLAN copy?',
    (clan.mine ? 'This phone may hold the only copy. CLAN history and hosting authority will be removed. Other devices keep their copies. ' : 'Remove local CLAN history and leave membership. Remote revocation cannot be confirmed here. ') +
    'Personal study data, Course files, exports and edited files stay. Older downloads without ownership records may remain. Failed cleanup stays unavailable and can be retried.',
    [{ text: 'Cancel', style: 'cancel' }, { text: clan.mine ? 'Delete' : 'Remove', style: 'destructive', onPress: () => void run(clan.id, clan.mine ? 'delete' : 'remove') }]);
  const visible = new Set([...active, ...archived].map((clan) => clan.id));
  return <Card title="My CLANs">
    <Muted small>Membership and stored files remain when archived. Live rooms require an online authorized host.</Muted>
    {active.map((clan) => <View key={clan.id}><Muted>{clan.name}</Muted><Btn disabled={!!busy} label={`Archive ${clan.name}`} onPress={() => Alert.alert('Archive on this phone?', 'Hide this CLAN from My CLANs. Files and membership remain; restore it below.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Archive', onPress: () => change(clan.id, true) }])} />
      {!phoneClan().clans.members(clan.id).some((member) => member.userId === phoneClan().me && member.role === 'owner') && <Btn disabled={!!busy} label={`Leave ${clan.name}`} onPress={() => Alert.alert('Leave on this phone?', 'Personal data and stored copies stay. This offline action cannot confirm host revocation. Joining again follows the host’s current approval policy.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => setErr(act(() => phoneClan().clans.leave(clan.id, phoneClan().me))) }])} />}
    </View>)}
    {!!archived.length && <Muted>Archived on this phone</Muted>}
    {archived.map((clan) => <View key={clan.id}><Muted>{clan.name}</Muted><Btn disabled={!!busy} label={`Restore ${clan.name}`} onPress={() => change(clan.id, false)} /></View>)}
    {!!copies.length && <Muted>Stored copies on this phone</Muted>}
    {copies.map((clan) => <View key={clan.id}>{!visible.has(clan.id) && <Muted>{clan.name} · left or ended</Muted>}<Btn disabled={!!busy} danger label={`${clan.mine ? 'Delete' : 'Remove copy of'} ${clan.name}`} onPress={() => remove(clan)} /></View>)}
    {pending.map((item) => <View key={item.clanId}><Muted>{phoneClan().clans.get(item.clanId)?.name ?? 'CLAN'} · cleanup pending</Muted><Btn disabled={!!busy} label="Retry cleanup" onPress={() => void run(item.clanId, item.kind)} /></View>)}
    {!!busy && <Muted>Removing local copy…</Muted>}{!!notice && <Muted>{notice}</Muted>}{err && <Muted>{err}</Muted>}
  </Card>;
}

function MeScreen({ onDevices, onHosting, onEditProfile }: { onDevices(): void; onHosting(): void; onEditProfile(): void }) {
  const name = useData(() => phoneClan().identity.displayName(phoneClan().me)) ?? '';
  const [n, setN] = useState(name), [err, setErr] = useState<string | null>(null);
  return (
    <Screen>
      <RoomBand title="Me" right={<Mate name={name || 'Me'} size={52} />} />
      <Card title="You">
        <Field label="Your name" value={n} onChange={setN} maxLength={80} />
        <Row><Btn label="Save name" disabled={!n.trim()} onPress={() => { setErr(act(() => phoneClan().identity.rename(phoneClan().me, n))); void syncNow(); }} /><Btn label="Join details" a11y="Edit name, roll number and device name for joining CLANs" onPress={onEditProfile} /></Row>
        {err && <Muted>{err}</Muted>}
      </Card>
      <Card title="My Devices"><Muted>Link this phone to your computer and keep your study data in step, offline-first.</Muted><Btn primary label="Open My Devices" onPress={onDevices} /></Card>
      <Card title="Hosting"><Muted>Own CLANs from this phone and let your computer host them.</Muted><Btn label="Open Hosting" onPress={onHosting} /></Card>
      <Card title="Privacy"><Muted small>Everything is stored encrypted on this phone. Notes and links are private until you file them into a CLAN. Diary is never shared or searchable; AI reads it only if you allow it. Your AI key stays in this phone's secure storage.</Muted></Card>
    </Screen>
  );
}
