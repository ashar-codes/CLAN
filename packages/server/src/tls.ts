import 'reflect-metadata'; // required by @peculiar/x509's DI container
import * as x509 from '@peculiar/x509';
import { createHash, createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** Lifetime of a classroom certificate. The class is ended before it expires. */
export const CERT_LIFETIME_MS = 24 * 60 * 60_000;

export type ClassroomTls = {
  certPem: string;
  /** PKCS#8 PEM, held in memory only for the lifetime of the server; never written to disk. */
  keyPem: string;
  certificate: string; // base64 DER
  spkiSha256: string; // base64
  notAfter: number;
};

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/**
 * Fresh self-signed ECDSA P-256 certificate per classroom session (standard X.509 via @peculiar/x509 over WebCrypto;
 * no shelling out to openssl). Not a CA, server-auth only. Clients don't validate names; they pin the SPKI that was
 * authenticated through OPAQUE, so it carries no IP/host SAN and survives an address change.
 */
export async function createClassroomTls(sessionId: string, now = Date.now()): Promise<ClassroomTls> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const serial = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
  serial[0]! &= 0x7f; // positive INTEGER
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: `CN=Classroom LAN ${sessionId}`,
    notBefore: new Date(now - 5 * 60_000),
    notAfter: new Date(now + CERT_LIFETIME_MS),
    keys: keys as unknown as CryptoKeyPair,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const certPem = cert.toString('pem');
  const der = Buffer.from(cert.rawData);
  return {
    certPem,
    keyPem: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }) as string,
    certificate: der.toString('base64'),
    spkiSha256: createHash('sha256').update(new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    notAfter: now + CERT_LIFETIME_MS,
  };
}
