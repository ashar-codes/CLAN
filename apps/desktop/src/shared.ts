import type { DiscoveredClassroom } from '@classroom/server/discovery';
import type { Iface } from '@classroom/server';
import type { JoinPolicy, Receipt, ResourceView, StudentProfile, TransferState } from '@classroom/protocol';

export type Capabilities = {
  platform: string;
  lanMode: boolean;
  directMode: { available: boolean; reason: string };
  interfaces: Iface[];
  hostname: string;
};

export type StartedClassroom = { url: string; code: string; teacherToken: string; title: string; host: string; iface: string };

export type FileState = { resourceId: string; state: TransferState; bytes: number; size: number; resumedFrom?: number; error?: string; canOpen?: boolean };
export type Conn = { url: string; token: string; sessionId: string; classTitle: string };
export type PastClass = { sessionId: string; title: string; startedAt: number; endedAt: number | null; files: number; submissions: number };

/** API exposed by the preload as window.classroom. */
export type DesktopApi = {
  capabilities(): Promise<Capabilities>;
  getProfile(): Promise<Partial<StudentProfile> & { deviceId: string }>;
  saveProfile(p: Omit<StudentProfile, 'deviceId'>): Promise<StudentProfile>;
  startClassroom(a: { title: string; policy: JoinPolicy; host?: string }): Promise<StartedClassroom>;
  stopClassroom(): Promise<void>;
  discover(onList: (list: DiscoveredClassroom[]) => void): () => void;

  // teacher
  addFiles(): Promise<{ added: number; errors: string[] }>;
  onImportProgress(cb: (p: { resourceId: string; bytes: number; size: number }) => void): () => void;
  revealSubmission(submissionId: string): Promise<void>;
  pastClasses(): Promise<PastClass[]>;
  revealPastClass(sessionId: string): Promise<void>;

  // student
  fileStatus(c: Conn, resources: ResourceView[]): Promise<FileState[]>;
  download(c: Conn, r: ResourceView): Promise<void>;
  pause(resourceId: string): Promise<void>;
  showFile(sessionId: string, resourceId: string): Promise<void>;
  openFile(sessionId: string, resourceId: string): Promise<void>;
  onFileState(cb: (s: FileState) => void): () => void;
  pickSubmission(allowedExtensions: string[]): Promise<{ pickId: string; name: string; size: number } | null>;
  submit(c: Conn, assignmentId: string, pickId: string): Promise<Receipt>;
  onUploadProgress(cb: (p: { assignmentId: string; sent: number; size: number }) => void): () => void;
  receipts(sessionId?: string): Promise<Receipt[]>;
};
