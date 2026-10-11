import { requireOptionalNativeModule } from 'expo-modules-core';
type Native = { openWith(uri: string, sha256: string): Promise<void>; saveCopy(uri: string, destination: string, sha256: string, size: number): Promise<void> };
const native = requireOptionalNativeModule<Native>('ClanFileActions');
export const nativeFileActions = () => { if (!native) throw new Error('Native file actions are unavailable in this build.'); return native; };
