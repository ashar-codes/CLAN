// Noble's direct-link ephemerals/nonces use Web Crypto. Hermes does not provide it.
// Expo's native getRandomValues uses the OS CSPRNG and fails closed if unavailable.
import { getRandomValues } from 'expo-crypto';

type RandomSource = { getRandomValues?: typeof getRandomValues };
export function installSecureRandom(target: { crypto?: RandomSource } = globalThis as unknown as { crypto?: RandomSource }) {
  if (target.crypto?.getRandomValues) return; // preserve an existing platform implementation
  if (!target.crypto) Object.defineProperty(target, 'crypto', { value: {}, configurable: true, writable: true });
  Object.defineProperty(target.crypto!, 'getRandomValues', { value: getRandomValues, configurable: true });
}
installSecureRandom();
