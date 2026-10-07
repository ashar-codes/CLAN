// The per-class TLS identity is shared with peers (who also serve over TLS), so it lives in @classroom/client.
export { createClassroomTls, CERT_LIFETIME_MS, type ClassroomTls } from '@classroom/client/tls';
