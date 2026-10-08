// My Space: the production home. A room made of real objects with real counts; every object is a button with a label,
// and the same actions exist as quick actions and a conventional "Today" panel (the Minimal experience shows only those).
import type { KeyboardEvent, ReactNode } from 'react';
import { ClanPlace, CLANBeacon, CLANmate, mateFor, type BeaconState } from '@clan/design';
import type { AgendaItem, HomeView } from '../../shared.ts';
import { openItem, useStudy } from './study/common.tsx';
import type { Experience } from './experience.ts';

export type SpaceTarget = 'commons' | 'clans' | 'study' | 'notes' | 'saved' | 'me' | 'diary' | 'guide' | 'exams' | 'board' | 'tasks' | `course:${string}`;

function Obj({ label, hint, onGo, children }: { label: string; hint: string; onGo(): void; children: ReactNode }) {
  return (
    <g className="obj" role="button" tabIndex={0} aria-label={`${label}: ${hint}`} onClick={onGo}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGo(); } }}>
      {children}
      <title>{label} — {hint}</title>
    </g>
  );
}

const days = (ts: number | null) => (ts === null ? 0 : Math.max(0, Math.ceil((ts - Date.now()) / 86_400_000)));
const KIND: Record<AgendaItem['kind'], string> = { exam: 'Exam', task: 'Task', assignment: 'Classroom Assignment', reminder: 'Reminder', session: 'Planned study' };
const hhmm = (ts: number | null) => (ts === null ? '' : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

export function MySpace({ h, nearby, beacon, experience, go, quick }: {
  h: HomeView; nearby: number; beacon: BeaconState; experience: Experience; go(t: SpaceTarget): void; quick: ReactNode;
}) {
  const { notes, saved, courses } = h.library;
  const books = [
    ...Array.from({ length: Math.min(courses, 4) }, () => 'var(--burgundy)'),
    ...Array.from({ length: Math.min(notes, 5) }, () => 'var(--study)'),
    ...Array.from({ length: Math.min(saved, 4) }, () => 'var(--notebook)'),
  ];
  const { go: goStudy, session } = useStudy();
  const pins = h.upcoming.slice(0, 3);
  const latest = h.continueNotes[0];
  const desk = session ? { label: 'Studying', hint: session.goal || 'study session running', go: () => goStudy({ tab: session.courseId ? 'campus' : 'history', ...(session.courseId ? { courseId: session.courseId } : {}) }) }
    : h.latestCourse ? { label: h.latestCourse.code || h.latestCourse.name, hint: `open ${h.latestCourse.name}`, go: () => go(`course:${h.latestCourse!.id}`) }
    : { label: latest ? 'Continue' : 'Start writing', hint: latest ? `continue “${latest.title}”` : 'start a note', go: () => go('notes') };
  return (
    <div className="space">
      {experience !== 'minimal' && (
        <svg className="room" viewBox="0 0 1000 520" role="group" aria-label="My Space">
          <defs>
            <linearGradient id="win" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--window)" /><stop offset="1" stopColor="var(--notebook-soft)" /></linearGradient>
            <radialGradient id="lamp" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="var(--notebook)" stopOpacity=".55" /><stop offset="1" stopColor="var(--notebook)" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width="1000" height="380" fill="var(--wall)" />
          <rect y="380" width="1000" height="140" fill="var(--floor)" />
          <path d="M0 380h1000" stroke="var(--line)" strokeWidth="6" />
          <g aria-hidden><rect x="575" y="60" width="190" height="140" rx="10" fill="url(#win)" stroke="var(--line)" strokeWidth="8" /><path d="M670 60v140M575 130h190" stroke="var(--line)" strokeWidth="6" /></g>

          <Obj label="Library" hint={`${notes} notes, ${saved} saved, ${courses} courses`} onGo={() => go('study')}>
            <rect x="56" y="110" width="210" height="282" rx="8" fill="var(--wood)" /><rect x="66" y="120" width="190" height="262" fill="var(--wood-dark)" />
            {[208, 296, 382].map((y) => <rect key={y} x="62" y={y - 6} width="198" height="10" fill="var(--wood)" />)}
            {books.length === 0 && <text x="160" y="250" className="obj-hint">empty shelves</text>}
            {books.map((c, i) => { const shelf = Math.floor(i / 6), x = 74 + (i % 6) * 30; return <rect key={i} x={x} y={(shelf ? 290 : 202) - 64 - (i % 3) * 6} width="24" height={64 + (i % 3) * 6} rx="3" fill={c} />; })}
            <text x="160" y="368" className="obj-label">Library</text>
          </Obj>

          <Obj label="Semester board" hint={pins.length ? `${pins.length} coming up` : 'nothing due'} onGo={() => go('board')}>
            <rect x="300" y="60" width="220" height="168" rx="10" fill="#d8b98f" stroke="var(--wood)" strokeWidth="6" />
            {pins.length === 0 && <text x="410" y="150" className="obj-hint dark">nothing due</text>}
            {pins.map((r, i) => (
              <g key={r.id} transform={`translate(${316 + i * 66} ${84 + (i % 2) * 12}) rotate(${i === 1 ? 4 : -3})`}>
                <rect width="56" height="62" rx="3" fill={i === 0 ? '#fbe9be' : '#fffbf3'} /> {/* paper notes stay paper at night */}
                <text x="28" y="30" textAnchor="middle" className="pin-num">{days(r.at)}</text>
                <text x="28" y="46" textAnchor="middle" className="pin-sub">days</text>
                <circle cx="28" cy="4" r="4" fill="var(--brick)" />
              </g>
            ))}
            <text x="410" y="214" className="obj-label">Semester board</text>
          </Obj>

          <g aria-hidden><rect x="420" y="322" width="390" height="20" rx="6" fill="var(--wood)" /><rect x="440" y="342" width="14" height="130" fill="var(--wood-dark)" /><rect x="776" y="342" width="14" height="130" fill="var(--wood-dark)" /></g>

          <Obj label="Desk" hint={desk.hint} onGo={desk.go}>
            <path d="M470 322l14-70h150l14 70z" fill="#22304a" /><path d="M490 262h138l-10 52H480z" fill="var(--study-soft)" />
            <path d="M500 276h70M500 288h96M500 300h50" stroke="#22304a" strokeWidth="5" strokeLinecap="round" opacity=".45" />
            {session && <circle cx="640" cy="262" r="7" fill="var(--study)" />}
            <text x="560" y="242" className="obj-label">{desk.label}</text>
          </Obj>

          <Obj label="Journal" hint="your private Diary" onGo={() => go('diary')}>
            <g transform="rotate(-6 714 307)"><rect x="672" y="296" width="84" height="22" rx="4" fill="var(--campus)" /><rect x="676" y="292" width="80" height="8" rx="2" fill="#fffbf3" /><path d="M740 292v30" stroke="var(--brick)" strokeWidth="4" /></g>
            {h.diaryToday && <circle cx="760" cy="290" r="5" fill="var(--campus)" />}
            <text x="714" y="282" className="obj-label">Diary</text>
          </Obj>

          <Obj label="CLAN Guide" hint="contextual help" onGo={() => go('guide')}>
            <circle cx="440" cy="232" r="64" fill="url(#lamp)" />
            <path d="M440 322v-60l-24-30" stroke="#22304a" strokeWidth="6" fill="none" strokeLinecap="round" />
            <path d="M396 222l36-22 16 26z" fill="#22304a" />
            <g className="guide-dots"><circle cx="432" cy="250" r="5" fill="var(--ai)" /><circle cx="446" cy="244" r="4" fill="var(--notebook)" /><circle cx="440" cy="260" r="3.5" fill="var(--study)" /></g>
            <text x="440" y="186" className="obj-label">Guide</text>
          </Obj>

          <Obj label="Backpack" hint={`${h.inboxCount} in your Inbox`} onGo={() => go('saved')}>
            <path d="M800 498c-6-62 10-96 50-96s56 34 50 96z" fill="var(--notebook)" /><rect x="822" y="438" width="56" height="34" rx="10" fill="color-mix(in srgb, var(--notebook) 80%, black)" />
            <path d="M830 410c0-26 40-26 40 0" stroke="color-mix(in srgb, var(--notebook) 80%, black)" strokeWidth="8" fill="none" />
            {h.inboxCount > 0 && <><circle cx="896" cy="414" r="17" fill="var(--brick)" /><text x="896" y="420" textAnchor="middle" className="badge">{h.inboxCount}</text></>}
            <text x="850" y="514" className="obj-label">Inbox</text>
          </Obj>

          <Obj label="Commons" hint={nearby ? `${nearby} CLAN${nearby === 1 ? '' : 's'} nearby` : 'nobody nearby right now'} onGo={() => go('commons')}>
            <rect x="880" y="110" width="110" height="282" rx="6" fill="var(--campus)" /><rect x="892" y="122" width="86" height="270" fill="color-mix(in srgb, var(--campus) 82%, white)" />
            <circle cx="968" cy="260" r="6" fill="var(--notebook)" />
            <rect x="884" y="72" width="102" height="28" rx="14" fill="var(--surface)" /><text x="935" y="91" textAnchor="middle" className="door-sign">{nearby ? `${nearby} nearby` : 'Commons'}</text>
            <text x="935" y="370" className="obj-label light">Commons →</text>
          </Obj>

          <Obj label="You" hint="profile and settings" onGo={() => go('me')}>
            <foreignObject x="250" y="300" width="130" height="190"><CLANmate spec={mateFor(h.me.name)} beacon={beacon} size={170} /></foreignObject>
          </Obj>
        </svg>
      )}
      <div className="space-side">
        <div className="space-hello"><span className="eyebrow">My Space · {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          <h1 className="title world">Hi {h.me.name === 'Me' ? 'there' : h.me.name}</h1></div>
        {quick}
        <section className="today-list" aria-label="Today" data-testid="today">
          {h.today.slice(0, 8).map((i) => (
            <button key={i.kind + i.id + i.at} className={`today-row ${i.overdue ? 'overdue' : ''}`} onClick={() => openItem(i, goStudy)} data-testid="today-item">
              <span className={`dot-ic k-${i.kind}`} /><span className="grow"><b>{i.title}</b><br /><small className="muted">{KIND[i.kind]}{i.at ? ` · ${days(i.at) === 0 ? (i.overdue ? 'overdue' : `today ${hhmm(i.at)}`) : `in ${days(i.at)} day${days(i.at) === 1 ? '' : 's'}`}` : ''}{i.kind === 'assignment' ? ` · ${i.status}` : ''}</small></span>
            </button>
          ))}
          {h.today.length === 0 && <button className="today-row" onClick={() => go('board')}><span className="dot-ic notebook" />Nothing due today · open the Semester Board</button>}
          <button className="today-row" onClick={() => go('notes')}><span className="dot-ic study" />{latest ? <>Continue <b>{latest.title}</b></> : 'Write your first note'}</button>
          <button className="today-row" onClick={() => go('saved')}><span className="dot-ic brick" />{h.inboxCount ? <><b>{h.inboxCount}</b> in your Inbox</> : 'Inbox is empty'}</button>
          <button className="today-row" onClick={() => go('commons')}><CLANBeacon state={nearby ? 'available' : 'away'} size={16} />{nearby ? <><b>{nearby}</b> CLAN{nearby === 1 ? '' : 's'} nearby</> : 'No CLANs nearby'}</button>
          <button className="today-row" onClick={() => go('diary')}><span className="dot-ic campus" />{h.diaryToday ? 'Diary written today' : 'Write today’s Diary'}</button>
        </section>
      </div>
      {experience !== 'minimal' && h.clans.length > 0 && (
        <section className="space-places" aria-label="Your CLANs">
          {h.clans.slice(0, 6).map((c) => (
            <button key={c.id} className="card space-place" onClick={() => go('clans')} aria-label={`${c.name}, ${c.members} members`}>
              <ClanPlace type={c.type} members={c.members} files={0} title={c.name} /><b>{c.name}</b><span className="muted small-text">{c.members} member{c.members === 1 ? '' : 's'}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
