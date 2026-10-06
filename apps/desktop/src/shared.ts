import type { DiscoveredClassroom } from '@classroom/server/discovery';
import type { Iface } from '@classroom/server';
import type { JoinPolicy, StudentProfile } from '@classroom/protocol';

export type Capabilities = {
  platform: string;
  lanMode: boolean;
  directMode: { available: boolean; reason: string };
  interfaces: Iface[];
  hostname: string;
};

export type StartedClassroom = { url: string; code: string; teacherToken: string; title: string; host: string; iface: string };

/** API exposed by the preload as window.classroom. */
export type DesktopApi = {
  capabilities(): Promise<Capabilities>;
  getProfile(): Promise<Partial<StudentProfile> & { deviceId: string }>;
  saveProfile(p: Omit<StudentProfile, 'deviceId'>): Promise<StudentProfile>;
  startClassroom(a: { title: string; policy: JoinPolicy; host?: string }): Promise<StartedClassroom>;
  stopClassroom(): Promise<void>;
  discover(onList: (list: DiscoveredClassroom[]) => void): () => void;
};
