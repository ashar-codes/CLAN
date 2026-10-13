/** Signed package metadata selects a disposable QA profile; ordinary builds keep legacy storage. */
export function qaProfile(metadata: unknown) {
  const m = metadata as Record<string, unknown> | null;
  if (!m || m.clanInternalQa !== true) return undefined;
  const profile = m.clanQaProfile ?? 'personal-beta-test';
  const appId = m.clanQaAppId ?? 'app.classroomlan.desktop.qa';
  if (typeof profile !== 'string' || !/^[\w-]{1,32}$/.test(profile) ||
      typeof appId !== 'string' || !/^app\.classroomlan\.desktop\.[a-z0-9.]+$/.test(appId)) {
    throw new Error('Invalid internal QA profile metadata; refusing to open a different profile.');
  }
  return { profile, appId };
}
