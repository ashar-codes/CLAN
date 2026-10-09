// Share to CLAN: something shared from another app (link, text, photo, file) lands here. It is validated again, saved
// privately to the Inbox (works offline), and filed somewhere else only if the student picks a destination. Nothing is
// ever posted to a group automatically.
import { useEffect, useState } from 'react';
import { Linking, Text } from 'react-native';
import { discardShared, onShare, takeShare } from '../../modules/share-intake';
import type { Shared } from './items';
import { phoneClan, me } from '../core/clan';
import { destinations } from '../screens/Inbox';
import { intakeItems } from './items';
import { bump, Btn, Card, Err, H1, Muted, Screen, useC } from '../ui/kit';

/** Watches for shares (app launched by a share, a share while running, iOS clan://share links). */
export function useIncomingShare() {
  const [share, setShare] = useState<Shared | null>(null);
  useEffect(() => {
    const pull = (id?: string) => void takeShare(id).then((s) => s && setShare(s), (e) => console.warn('Share to CLAN: could not read the share', e));
    const fromUrl = (u: string | null) => { const m = u && /^clan:\/\/share\?id=([0-9A-F-]{36})$/i.exec(u); if (m) pull(m[1]); };
    pull(); void Linking.getInitialURL().then(fromUrl);
    const a = onShare(() => pull()), b = Linking.addEventListener('url', (e) => fromUrl(e.url));
    return () => { a(); b.remove(); };
  }, []);
  return [share, () => setShare(null)] as const;
}

export function IntakeScreen({ share, onDone }: { share: Shared; onDone(): void }) {
  const c = useC();
  const { items, refused } = intakeItems(share);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [savedIds, setSavedIds] = useState<string[] | null>(null);
  const finish = () => { discardShared(share.files.map((f) => f.uri)); bump(); onDone(); };
  const save = async () => { // always the private Inbox first (offline)
    setBusy(true); setErr(null);
    try { const ids: string[] = []; for (const i of items) ids.push((await phoneClan().capture.capture(me(), i)).id); setSavedIds(ids); bump(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const fileAll = (to: ReturnType<typeof destinations>[number]) => {
    try { for (const id of savedIds ?? []) { const it = phoneClan().capture.inbox(me()).find((x) => x.id === id); if (it && to.modules.includes(it.module)) phoneClan().capture.file(me(), id, to.to); } finish(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Screen>
      <H1>Share to CLAN</H1>
      <Card title={`${items.length} item${items.length === 1 ? '' : 's'}`} tone="warn">
        {items.map((i, n) => <Text key={n} style={{ color: c.text }} numberOfLines={2}>{i.kind === 'link' ? `↗ ${i.title ?? i.url}` : i.kind === 'file' ? `📎 ${i.name}` : i.kind === 'text' ? `❝ ${i.text}` : ''}</Text>)}
        {refused.map((r, n) => <Muted key={n} small>{r}</Muted>)}
        {!savedIds ? (<>
          <Btn primary label={busy ? 'Saving…' : 'Save to my Inbox'} disabled={busy || !items.length} onPress={() => void save()} />
          <Btn label="Cancel" onPress={finish} />
          <Muted small>Saved privately on this phone. Nothing is shared with anyone.</Muted>
        </>) : (<>
          <Muted>In your Inbox. Also file it somewhere?</Muted>
          {destinations().map((d) => <Btn key={d.key} small label={d.label} onPress={() => fileAll(d)} />)}
          <Btn primary label="Keep in Inbox" onPress={finish} />
        </>)}
        <Err msg={err} />
      </Card>
    </Screen>
  );
}
