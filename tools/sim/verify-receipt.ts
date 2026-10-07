// Verify an archived CLAN receipt offline (no classroom needed).
// Usage: node tools/sim/verify-receipt.ts <receipt.json> [--teacher-key <base64url Ed25519 public key>] [--session <id>]
// Exit codes: 0 verified against the given teacher key; 1 verification failed; 2 signature internally consistent but
// no trusted teacher key was supplied (so it proves nothing about WHO signed it).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { keyFingerprint, shortFingerprint, verifyReceipt, type Receipt } from '@classroom/protocol';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'teacher-key': { type: 'string' }, session: { type: 'string' } } });
if (!positionals[0]) { console.error('usage: verify-receipt <receipt.json> [--teacher-key KEY] [--session ID]'); process.exit(1); }
let receipt: Receipt;
try { receipt = JSON.parse(readFileSync(positionals[0], 'utf8')); } catch (e) { console.error(`Verification failed: cannot read receipt (${(e as Error).message})`); process.exit(1); }
const r = verifyReceipt(receipt, { trustedTeacherKey: values['teacher-key'], sessionId: values.session });
if (!r.ok) { console.error(`Verification failed: ${r.reason}`); process.exit(1); }
const p = r.payload;
console.log(`${p.fullName} (${p.rollNo}) submitted "${p.fileName}" (${p.size} bytes, SHA-256 ${p.sha256})`);
console.log(`for "${p.assignmentTitle}" in "${p.courseTitle}" at ${new Date(p.submittedAt).toISOString()} (server time), ${p.late ? 'LATE' : 'on time'}, version ${p.version}`);
console.log(`Signed by teacher key ${shortFingerprint(keyFingerprint(receipt.teacherPublicKey))}`);
if (!values['teacher-key']) { console.log('Signature is valid, but no --teacher-key was given: this does not prove which teacher signed it.'); process.exit(2); }
console.log('Verified ✓');
