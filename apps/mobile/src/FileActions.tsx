import { useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canOpenFile, previewKind, previewImageMime, TEXT_PREVIEW_BYTES, IMAGE_PREVIEW_BYTES, type FilePreview } from '@classroom/client';
import { safeFileName, type ResourceView } from '@classroom/protocol';
import { nativeFileActions } from '../modules/file-actions';
import { downloadedFile, type Conn } from './transfers';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string };
async function verify(file: File, expected: string) {
  const fh = file.open(), hash = sha256.create(); let blocks = 0;
  try { for (;;) { const chunk = fh.readBytes(1 << 20); if (!chunk.length) break; hash.update(chunk); if (++blocks % 4 === 0) await new Promise((r) => setTimeout(r, 0)); } }
  finally { fh.close(); }
  if (bytesToHex(hash.digest()) !== expected) throw new Error('This file changed after download. Download it again.');
}
export function MobileFileActions({ c, conn, resource }: { c: C; conn: Conn; resource: ResourceView }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [view, setView] = useState<FilePreview | null>(null), [notice, setNotice] = useState('');
  const act = async (action: 'preview' | 'open' | 'save') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const file = downloadedFile(conn, resource), expected = resource.sha256!;
      if (action === 'preview') {
        await verify(file, expected);
        const kind = previewKind(resource.name);
        if (kind === 'text' && resource.size <= TEXT_PREVIEW_BYTES) { const text = file.textSync(); setView(text.includes('\0') ? { kind: 'metadata', reason: 'No text preview for binary data.' } : { kind: 'text', text }); }
        else if (kind === 'image' && resource.size <= IMAGE_PREVIEW_BYTES && previewImageMime(file.bytesSync())) setView({ kind: 'image', uri: file.uri });
        else setView({ kind: 'metadata', reason: 'No embedded preview for this file or size. Use a viewer or save a copy.' });
      } else if (Platform.OS === 'android') {
        if (action === 'open') await nativeFileActions().openWith(file.uri, expected);
        else {
          const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync(); if (!permission.granted) return;
          const target = await StorageAccessFramework.createFileAsync(permission.directoryUri, safeFileName(resource.name), 'application/octet-stream');
          await nativeFileActions().saveCopy(file.uri, target, expected, resource.size); setNotice('Saved a verified copy.');
        }
      } else {
        await verify(file, expected);
        if (!await Sharing.isAvailableAsync()) throw new Error('The system file sheet is unavailable.');
        await Sharing.shareAsync(file.uri, { dialogTitle: action === 'save' ? 'Save to Files' : 'Open with' });
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const button = (label: string, action: 'preview' | 'open' | 'save') => <Pressable key={action} accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void act(action)} style={{ minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12 }}><Text style={{ color: c.accent }}>{label}</Text></Pressable>;
  return <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{button('Preview', 'preview')}{canOpenFile(resource.name) && button('Open with…', 'open')}{button('Save to Files', 'save')}</View>
    {!!notice && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{notice}</Text>}
    {!!error && <Text style={{ color: c.danger }} accessibilityLiveRegion="polite">{error}</Text>}
    {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">Checking file…</Text>}
    <Modal visible={!!view} animationType="slide" onRequestClose={() => setView(null)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.surface, padding: 16 }}>
        <Text accessibilityRole="header" style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>{resource.name}</Text>
        <Pressable accessibilityRole="button" style={{ minHeight: 48, justifyContent: 'center' }} onPress={() => setView(null)}><Text style={{ color: c.accent }}>Close preview</Text></Pressable>
        {view?.kind === 'image' ? <Image source={{ uri: view.uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel={resource.name} /> : <ScrollView>{view && <Text selectable style={{ color: c.text }}>{view.kind === 'text' ? view.text : view.reason}</Text>}</ScrollView>}
      </SafeAreaView>
    </Modal>
  </>;
}
