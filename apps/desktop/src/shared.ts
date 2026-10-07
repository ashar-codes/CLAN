import type { DiscoveredClassroom } from '@classroom/server/discovery';
import type { Iface } from '@classroom/server';
import type { ClassroomInfo, JoinPolicy, MemberStatus, Receipt, ResourceView, StudentProfile, TransferState } from '@classroom/protocol';
import type { KeystoreStatus } from './main/keystore.ts';

export type Capabilities = {
  platform: string;
  lanMode: boolean;
  directMode: { available: boolean; reason: string };
  interfaces: Iface[];
  hostname: string;
  keystore: KeystoreStatus;
};

/** Student's own profile; the public key comes from the OS-protected device key and can't be edited. */
export type OwnProfile = Partial<Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>> & { devicePublicKey: string; fingerprint: string };
export type StoredReceipt = { receipt: Receipt; verified: boolean; reason?: string };
export type TeacherTrust = 'first' | 'known' | 'changed';
export type Joined = {
  url: string; token: string; memberId: string; status: MemberStatus; classroom: ClassroomInfo;
  teacherPublicKey: string; teacherFingerprint: string; teacherTrust: TeacherTrust;
};

export type StartedClassroom = { url: string; code: string; teacherToken: string; title: string; host: string; iface: string };

export type FileState = { resourceId: string; state: TransferState; bytes: number; size: number; resumedFrom?: number; error?: string; canOpen?: boolean };
/** `url` is informational: main routes every request through the session it paired with. */
export type Conn = { url: string; token: string; sessionId: string; classTitle: string };
export type PastClass = { sessionId: string; title: string; startedAt: number; endedAt: number | null; files: number; submissions: number };

/** API exposed by the preload as window.classroom. */
export type DesktopApi = {
  capabilities(): Promise<Capabilities>;
  getProfile(): Promise<OwnProfile>;
  saveProfile(p: Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>): Promise<OwnProfile>;
  /** Secure join: discovery + OPAQUE with the code + pinned TLS + device-key proof, all in the main process. */
  joinClass(code: string, manualAddress?: string): Promise<Joined>;
  /** Device-key reconnect to an already-paired session (token expired, app restarted). No code needed. */
  rejoin(sessionId: string): Promise<Joined>;
  lastSession(): Promise<{ sessionId: string; title: string; savedAt: number } | null>;
  trustTeacher(title: string, teacherPublicKey: string): Promise<void>;
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
  submit(c: Conn, assignmentId: string, pickId: string): Promise<StoredReceipt>;
  onUploadProgress(cb: (p: { assignmentId: string; sent: number; size: number }) => void): () => void;
  receipts(sessionId?: string): Promise<StoredReceipt[]>;
  verifyReceipt(r: Receipt): Promise<StoredReceipt>;
};
