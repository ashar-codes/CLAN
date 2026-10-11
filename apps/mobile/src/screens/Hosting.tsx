// Me › Hosting on the phone: create a CLAN this phone owns and one of your computers hosts, see who hosts each CLAN you
// own, finish an interrupted hand-over, ask the host to move it, or stop a computer from hosting. Phones never host.
import { useState } from 'react';
import { Text } from 'react-native';
import type { ClanType } from '@classroom/protocol';
import { phoneClan } from '../core/clan';
import { createHostedClan, handToComputer, hostingOverview, linkedComputers, PHONE_HOSTING_BLOCKED, requestMove, revokeHost } from '../sync/hosting';
import { bump, Btn, Card, Choice, Field, H1, Muted, Row, Screen, useC, useData } from '../ui/kit';

type Overview = Awaited<ReturnType<typeof hostingOverview>>;
const TYPES = [['STUDY_GROUP', 'Study group'], ['PROJECT_TEAM', 'Project team'], ['FRIENDS', 'Friends'], ['CLASSROOM', 'Classroom']] as const;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export function HostingScreen() {
  const c = useC();
  const computers = useData(() => linkedComputers()) ?? [];
  const owned = useData(() => phoneClan().clans.list(phoneClan().me, { includeArchived: true }).filter((x) => phoneClan().clans.members(x.id).some((m) => m.userId === phoneClan().me && m.role === 'owner'))) ?? [];
  const [views, setViews] = useState<Record<string, Overview>>({});
  const [name, setName] = useState(''), [type, setType] = useState<ClanType>('STUDY_GROUP'), [to, setTo] = useState(''), [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null), [progress, setProgress] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null);
  const refresh = async () => { const out: Record<string, Overview> = {}; for (const x of owned) out[x.id] = await hostingOverview(x.id).catch(() => null as never); setViews(out); };
  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg(null); setConfirm(null);
    try { await f(); setMsg(done); } catch (e) { setMsg(`${(e as Error).message} Nothing was lost; you can try again.`); }
    finally { setBusy(false); setProgress(null); bump(); void refresh(); }
  };
  const onProgress = (d: number, t: number) => setProgress(`Sending ${mb(d)} of ${mb(t)}…`);
  const target = computers.find((d) => d.fp === to) ?? computers[0];

  return (
    <Screen>
      <H1>Hosting</H1>
      <Card tone="warn"><Muted>{PHONE_HOSTING_BLOCKED}</Muted></Card>
      {!computers.length && <Card><Muted>Link this phone to your computer first (Me › My Devices).</Muted></Card>}
      {msg && <Card><Text style={{ color: c.text }} accessibilityRole="alert">{msg}</Text></Card>}
      {progress && <Card><Text style={{ color: c.text }} accessibilityLiveRegion="polite">{progress}</Text></Card>}
      {computers.length > 0 && <Card title="New CLAN hosted on your computer">
        <Field label="CLAN name" value={name} onChange={setName} maxLength={80} />
        <Choice label="Type" value={type} options={TYPES} onChange={(v) => setType(v as ClanType)} />
        <Choice label="Host computer" value={target?.fp ?? ''} options={computers.map((d) => [d.fp, d.name] as const)} onChange={setTo} />
        {confirm === 'create'
          ? <><Muted small>This phone will own "{name.trim()}" and {target?.name} will host it. The CLAN is available while {target?.name} is on and CLAN is open there.</Muted>
            <Row><Btn primary label="Create and hand over" disabled={busy} onPress={() => void run(() => createHostedClan({ type, name: name.trim(), computerFp: target!.fp }, onProgress), `${target?.name} now hosts "${name.trim()}".`)} /><Btn label="Cancel" onPress={() => setConfirm(null)} /></Row></>
          : <Btn primary label="Create…" disabled={!name.trim() || !target || busy} onPress={() => setConfirm('create')} />}
      </Card>}
      <Btn label="Refresh hosting status" onPress={() => void refresh()} />
      {owned.map((x) => {
        const v = views[x.id], h = v?.hosting;
        return <Card key={x.id} title={x.name}>
          {!v ? <Muted small>Tap Refresh to see who hosts it.</Muted>
            : !h ? <Muted small>Only this phone holds it; it is not hosted.</Muted>
            : h.state === 'conflict' ? <Text style={{ color: c.text }} accessibilityRole="alert">Two hosts claim this CLAN. Open it on one of your computers to choose which record stands; nothing is deleted.</Text>
            : <Muted small>{h.hostKey === v.me ? (h.state === 'frozen' ? 'Paused here for a hand-over — finish it below.' : h.state === 'relinquished' ? 'Handed over; waiting for the computer to confirm. Try again below.' : 'Held on this phone, not hosted yet.') : `Hosted by ${v.hostName}${h.writable ? '' : ''}.`}</Muted>}
          {v?.preflight.filter((i) => i.blocking).map((i) => <Muted key={i.code} small>{i.message}</Muted>)}
          {h && h.hostKey === v!.me && target && <Btn label={h.state === 'active' ? `Hand over to ${target.name}` : `Finish hand-over to ${target.name}`} disabled={busy} onPress={() => void run(() => handToComputer(x.id, target.fp, [], onProgress), `${target.name} now hosts ${x.name}.`)} />}
          {h && h.hostKey !== v!.me && h.state !== 'conflict' && v!.isOwner && <Row>
            {computers.filter((d) => d.publicKey !== h.hostKey).slice(0, 2).map((d) => <Btn key={d.fp} small label={`Move to ${d.name}`} disabled={busy} onPress={() => void run(() => requestMove(x.id, d.fp), `Asked ${v!.hostName} to hand ${x.name} to ${d.name}. Confirm it there.`)} />)}
            {confirm === `revoke:${x.id}`
              ? <Btn small danger label={`Stop ${v!.hostName} hosting`} onPress={() => void run(() => revokeHost(x.id).then((r) => { if (r.notReached.length) setMsg(`Not yet told: ${r.notReached.join(', ')}. Try again when they are on.`); }), `${v!.hostName} no longer accepts changes for ${x.name}.`)} />
              : <Btn small danger label="Stop hosting…" onPress={() => setConfirm(`revoke:${x.id}`)} />}
          </Row>}
        </Card>;
      })}
    </Screen>
  );
}
