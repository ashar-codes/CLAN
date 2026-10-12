// Production shell: My Space / My CLANs / Nearby / Chats / Friends / Study / Saved / Me. The world is the navigation, every place also has a
// conventional equivalent, and the Visual Experience setting (Full / Reduced / Minimal) decides how much of it is drawn.
import { useCallback, useEffect, useState } from 'react';
import type { ClanType, HomeView } from '../shared.ts';
import { api } from './App.tsx';
import { useExperience } from './world/experience.ts';
import { useLoad } from './world/useLoad.ts';
import { MySpace, type SpaceTarget } from './world/MySpace.tsx';
import { Commons, type NearbyClan } from './world/Commons.tsx';
import { Clans } from './world/Clans.tsx';
import { Study } from './world/Study.tsx';
import { Ctx, SessionBar, useActiveSession, type StudyCtx, type StudyTarget } from './world/study/common.tsx';
import { Saved } from './world/Saved.tsx';
import { Me } from './world/Me.tsx';
import { NearbyPeople } from './world/people/NearbyPeople.tsx';
import { Chats } from './world/people/Chats.tsx';
import { Friends } from './world/people/Friends.tsx';
import { usePeople } from './world/people/common.tsx';
import { QuickCapture } from './world/QuickCapture.tsx';
import { useAI } from './world/ai/ctx.tsx';
import type { AIScope } from '../shared.ts';

type Tab = 'space' | 'clans' | 'commons' | 'chats' | 'friends' | 'study' | 'saved' | 'me';
const TABS: [Tab, string, string][] = [['space', 'My Space', '⌂'], ['clans', 'My CLANs', '▦'], ['commons', 'Nearby', '◎'], ['chats', 'Chats', '✉'], ['friends', 'Friends', '☻'], ['study', 'Study', '▥'], ['saved', 'Saved', '❏'], ['me', 'Me', '☺']];
type Rehost = { clanId: string; name: string; type: ClanType };

export function Shell({ onCreate, onJoin, onRehost }: { onCreate(type?: ClanType): void; onJoin(): void; onRehost(r: Rehost): void }) {
  const experience = useExperience();
  const [tab, setTab] = useState<Tab>('space');
  const [studyTarget, setStudyTarget] = useState<StudyTarget>({ tab: 'campus' });
  const [session, setSession] = useActiveSession();
  const [meSection, setMeSection] = useState<'profile' | 'diary'>('profile');
  const [nearby, setNearby] = useState<NearbyClan[]>([]);
  const [toast, setToast] = useState('');
  const ai = useAI();
  const [chatId, setChatId] = useState<string | null>(null);
  const openChat = (id: string) => { setChatId(id); setTab('chats'); };
  useEffect(() => api.people.onOpen((id) => { if (id) openChat(id); else setTab('friends'); }), []);
  const [convs] = usePeople(() => api.people.conversations());
  const unread = convs?.reduce((n, c) => n + c.unread + (c.state === 'invited_in' ? 1 : 0), 0) ?? 0;
  const [reqs] = usePeople(() => api.people.contacts('requests'));
  const incoming = reqs?.filter((r) => r.relation === 'incoming').length ?? 0;
  const [manualFocus, setFocus] = useState(false);
  // A Focus study session turns Focus Mode on; ending it restores whatever was set before. No penalties, no streaks.
  const focus = manualFocus || !!session?.focus;
  const [h, reloadHome] = useLoad<HomeView>(useCallback(() => api.clan.home(), []));
  useEffect(() => api.discover((l) => setNearby(l)), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (tab === 'space') reloadHome(); }, [tab, reloadHome]);
  useEffect(() => { void api.notify.context({ focus }); }, [focus]);
  useEffect(() => api.notify.on((n) => { if (document.hasFocus()) setToast(`${n.title}: ${n.body}`); }), []);

  const go = (t: SpaceTarget) => {
    if (t === 'guide') return ai.open({ mode: 'run', title: 'Ask CLAN', action: 'ask', scope: here(), ask: true });
    if (t === 'notes' || t === 'exams' || t === 'study' || t === 'board' || t === 'tasks') { setStudyTarget({ tab: t === 'study' ? 'campus' : t }); return setTab('study'); }
    if (t.startsWith('course:')) { setStudyTarget({ tab: 'campus', courseId: t.slice(7) }); return setTab('study'); }
    if (t === 'diary' || t === 'me') { setMeSection(t === 'diary' ? 'diary' : 'profile'); return setTab('me'); }
    setTab(t as Tab);
  };
  /** Ask CLAN defaults to where the student is. */
  const here = (): AIScope => tab === 'study' && studyTarget.examId ? { kind: 'exam', examId: studyTarget.examId } : tab === 'study' && studyTarget.courseId ? { kind: 'course', courseId: studyTarget.courseId } : { kind: 'global' };
  const openSource = (o: Record<string, unknown>) => {
    const s = (k: string) => String(o[k] ?? '');
    if (o.module === 'notes') { setStudyTarget({ tab: 'notes', noteId: s('id') }); setTab('study'); }
    else if (o.module === 'courses') { setStudyTarget({ tab: 'campus', courseId: s('courseId') }); setTab('study'); }
    else if (o.module === 'exams') { setStudyTarget({ tab: 'exams', examId: s('examId') }); setTab('study'); }
    else if (o.module === 'chat') setTab('clans');
    else if (o.module === 'saved') setTab('saved');
    else if (o.module === 'diary') { setMeSection('diary'); setTab('me'); }
    else if (o.module === 'recordings') { setStudyTarget({ tab: 'tapes', tapeId: s('tapeId') }); setTab('study'); }
  };
  useEffect(() => { ai.nav.current = openSource; return () => { ai.nav.current = null; }; });
  const study: StudyCtx = {
    target: studyTarget, go: (t) => { setStudyTarget(t); setTab('study'); }, session,
    start: async (o) => { try { setSession(await api.study.startSession(o)); setToast(o.focus ? 'Study session started · Focus on' : 'Study session started'); } catch (e) { setToast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } },
    end: async (reflection) => { if (!session) return; const s = await api.study.endSession(session.id, reflection || undefined); setSession(null); setToast(`Session saved · ${Math.max(1, Math.round((s.endedAt! - s.startedAt!) / 60_000))} min`); reloadHome(); },
  };
  const quick = (
    <div className="quick-actions" aria-label="Quick actions">
      <button className="primary" onClick={() => go('notes')}>New note</button>
      <button onClick={() => onCreate('CLASSROOM')}>Create Classroom</button>
      <button onClick={onJoin}>Join Classroom</button>
      <button onClick={() => onCreate('STUDY_GROUP')}>New CLAN</button>
      {session ? null : <button onClick={() => void study.start({ goal: 'Study', focus: true })}>Start studying</button>}
      <button aria-pressed={manualFocus} onClick={() => setFocus(!manualFocus)}>{manualFocus ? 'End focus' : 'Focus'}</button>
    </div>
  );

  return (
    <Ctx.Provider value={study}>
    <div className={`shell ${focus ? 'is-focus' : ''}`}>
      <header className="shell-top">
        <span className="brand-sm">CLAN</span>
        <button className="ask-clan" onClick={() => go('guide')} aria-label="Ask CLAN">Ask CLAN</button>
        <nav className="tabs-main" aria-label="Main">
          {TABS.map(([t, l, ic]) => { const n = t === 'chats' ? unread : t === 'friends' ? incoming : 0; return <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}><span className="tab-ic" aria-hidden>{ic}</span>{l}{n > 0 && <span className="badge" aria-label={`${n} new`}>{n}</span>}</button>; })}
        </nav>
      </header>
      <main className="shell-body" key={tab}>
        {tab === 'space' && h && <MySpace h={h} nearby={nearby.length} beacon={focus ? 'focus' : 'available'} experience={experience} go={go} quick={quick} />}
        {tab === 'commons' && <Commons nearby={nearby} experience={experience} onJoin={onJoin} onCreate={() => onCreate('STUDY_GROUP')} people={<NearbyPeople onChat={openChat} />} />}
        {tab === 'chats' && <Chats openId={chatId} setOpenId={setChatId} />}
        {tab === 'friends' && <Friends onChat={openChat} />}
        {tab === 'clans' && <Clans experience={experience} nearby={nearby} onCreate={onCreate} onJoin={onJoin} onRehost={onRehost} />}
        {tab === 'study' && <Study experience={experience} />}
        {tab === 'saved' && <Saved experience={experience} />}
        {tab === 'me' && <Me experience={experience} section={meSection} />}
      </main>
      {focus && <div className="focus-veil" aria-hidden />}
      <SessionBar onNote={() => go('notes')} />
      <QuickCapture onDone={(m, g) => { setToast(m); reloadHome(); if (g) go(g); }} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
    </Ctx.Provider>
  );
}
