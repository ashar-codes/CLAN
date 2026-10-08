// Presentation controls around the room wall: present / request / approve / stop / switch. Only actions the server
// will actually allow are shown; the server enforces them regardless.
import { useEffect, useState } from 'react';
import type { ClanCapability, ClientMessage } from '@classroom/protocol';
import { PresenterBar, SourcePicker, type Presentation, type PresentationMsg } from './Presentation.tsx';

export function RoomPresentation({ pres, msg, send, can, isHost, ask = 0 }: { pres: Presentation; msg: PresentationMsg | null; send(m: ClientMessage): void; can: ClanCapability[]; isHost: boolean; ask?: number }) {
  const [picker, setPicker] = useState<null | 'start' | 'switch' | 'takeover'>(null);
  useEffect(() => { if (ask) setPicker('start'); }, [ask]); // “Present” from the CLANmate wheel
  const live = pres.live;
  const manage = can.includes('MANAGE_PRESENTERS');
  const mine = msg?.mine ?? 'none';
  const mayPresent = isHost ? can.includes('PRESENT') : mine === 'approved';
  return (
    <div className="room-present" aria-label="Presentation">
      <PresenterBar pres={pres} onSwitch={() => setPicker('switch')} />
      {manage && msg?.requests.map((r) => (
        <div key={r.memberId} className="present-request" role="alert"><b>{r.name} wants to present</b>
          <button className="small primary" onClick={() => send({ t: 'present.approve', memberId: r.memberId })}>Allow</button>
          <button className="small" onClick={() => send({ t: 'present.decline', memberId: r.memberId })}>Decline</button></div>
      ))}
      {pres.busy && <div className="present-request" role="alert"><b>{pres.busy}</b>{manage && <button className="small" onClick={() => setPicker('takeover')}>Stop {live?.presenterName} and switch</button>}</div>}
      {pres.notice && <p className="muted small-text" role="status">{pres.notice}</p>}
      {!pres.presenting && (
        <div className="row">
          {mayPresent && <button className="primary small" onClick={() => setPicker('start')}>Present</button>}
          {!isHost && !mayPresent && can.includes('REQUEST_TO_PRESENT') && (mine === 'requested'
            ? <span className="muted small-text">Waiting for the host to let you present…</span>
            : <button className="small" onClick={() => send({ t: 'present.request' })}>Request to present</button>)}
          {live && manage && <button className="small danger" onClick={() => send({ t: 'present.stop', presentationId: live.id })}>Stop {live.presenterName}’s presentation</button>}
          {manage && <label className="inline small-text">Members present <select value={msg?.policy ?? 'open'} onChange={(e) => send({ t: 'present.policy', policy: e.target.value as 'open' | 'request' })} aria-label="Who may present">
            <option value="open">freely</option><option value="request">after asking</option></select></label>}
        </div>
      )}
      {picker && <SourcePicker title={picker === 'switch' ? 'Switch what you share' : 'Present'} onClose={() => setPicker(null)}
        onPick={(src, audio, profile) => { const p = picker; setPicker(null); void (p === 'switch' ? pres.switchTo(src, audio) : pres.start(src, audio, profile, p === 'takeover')); }} />}
    </div>
  );
}
