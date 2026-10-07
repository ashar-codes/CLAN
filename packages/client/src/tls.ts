import 'reflect-metadata'; // required by @peculiar/x509's DI container
import * as x509 from '@peculiar/x509';
import { createHash, createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** Lifetime of a classroom certificate. The class is ended before it expires. */
export const CERT_LIFETIME_MS = 24 * 60 * 60_000;

export type ClassroomTls = {
  /** Leaf + CA chain presented by the HTTPS server. */
  certPem: string;
  /** Leaf PKCS#8 PEM, held in memory only for the lifetime of the server; never written to disk. */
  keyPem: string;
  /** Per-session CA certificate (base64 DER): the only trust anchor clients accept for this classroom. */
  certificate: string;
  /** base64 SHA-256 of the LEAF certificate's SubjectPublicKeyInfo (the pin). */
  spkiSha256: string;
  notAfter: number;
};

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const serial = () => { const b = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))); b[0]! &= 0x7f; return b.toString('hex'); };

/**
 * Per-classroom TLS identity, standard X.509 via @peculiar/x509 over WebCrypto (no shelling out to openssl):
 *  - a one-off CA (ECDSA P-256, CA:TRUE, pathLen 0) whose private key exists only inside this function — it signs the
 *    leaf and is discarded, so nothing else can ever chain to it;
 *  - a leaf (ECDSA P-256, serverAuth) used by the HTTPS server.
 * Clients trust exactly this CA (delivered in the OPAQUE-authenticated binding) AND pin the leaf SPKI. A CA+leaf pair
 * is used rather than a lone self-signed leaf because BoringSSL (Electron, Chromium, Android) won't accept a non-CA
 * certificate as a trust anchor. No IP/host SAN: identity is the pin, so an address change doesn't matter.
 */
export async function createClassroomTls(sessionId: string, now = Date.now(), lifetimeMs = CERT_LIFETIME_MS): Promise<ClassroomTls> {
  const notBefore = new Date(now - 5 * 60_000), notAfter = new Date(now + lifetimeMs);
  const caKeys = (await webcrypto.subtle.generateKey(ALG, false, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(), name: `CN=Classroom LAN session CA ${sessionId}`, notBefore, notAfter, keys: caKeys, signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  const leafKeys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: serial(), subject: `CN=Classroom LAN ${sessionId}`, issuer: ca.subject, notBefore, notAfter,
    publicKey: leafKeys.publicKey, signingKey: caKeys.privateKey, signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey));
  const leafDer = Buffer.from(leaf.rawData);
  return {
    certPem: leaf.toString('pem') + '\n' + ca.toString('pem'),
    keyPem: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }) as string,
    certificate: Buffer.from(ca.rawData).toString('base64'),
    spkiSha256: createHash('sha256').update(new X509Certificate(leafDer).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    notAfter: notAfter.getTime(),
  };
}
