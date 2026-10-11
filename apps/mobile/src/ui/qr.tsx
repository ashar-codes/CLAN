// QR on the phone: drawing a code (react-native-svg, one path) and reading codes with the camera or from a picture
// (expo-camera). The camera starts only while a scanner is on screen and only after the person allows it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import * as QRCode from 'qrcode/lib/core/qrcode';
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Btn, Muted, Row, useC } from './kit';

/** One QR code as a single SVG path (fast enough to animate frames). */
export function QrImage({ text, size = 260, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const q = QRCode.create(text, { errorCorrectionLevel: text.length > 600 ? 'L' : 'M' });
    const m = q.modules, cells: string[] = [];
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.data[y * m.size + x]) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    return { path: cells.join(''), n: m.size + 8 };
  }, [text]);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ alignSelf: 'center', backgroundColor: '#fff', padding: 4, borderRadius: 8 }}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}><Rect x={0} y={0} width={n} height={n} fill="#fff" /><Path d={path} fill="#000" /></Svg>
    </View>
  );
}

/**
 * Camera scanner. `onCode` gets every distinct QR text (animated transfers need many per second); return true from it
 * to stop scanning. Also lets the person pick a saved picture of a code instead.
 */
export function QrScanner({ onCode, onClose, hint, continuous = false }: { onCode(text: string): boolean | void; onClose(): void; hint?: string; continuous?: boolean }) {
  const c = useC();
  const [perm, ask] = useCameraPermissions();
  const [err, setErr] = useState<string | null>(null), [active, setActive] = useState(true);
  const last = useRef(''), lastAt = useRef(0);
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) void ask(); }, [perm, ask]);
  const handle = (text: string) => {
    if (!active || !text) return;
    const now = Date.now();
    if (text === last.current && now - lastAt.current < (continuous ? 150 : 1500)) return;
    last.current = text; lastAt.current = now;
    if (onCode(text) === true) setActive(false);
  };
  const fromPicture = async () => {
    setErr(null);
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const uri = !r.canceled ? r.assets[0]?.uri : null;
    if (!uri) return;
    try {
      const found = await scanFromURLAsync(uri, ['qr']);
      if (!found.length) setErr('No code found in that picture.');
      for (const f of found) handle(f.data);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <View style={{ gap: 8 }}>
      {perm?.granted ? (
        <View style={{ height: 320, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' }}>
          {active && <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => handle(r.data)} accessibilityLabel="Camera viewfinder for scanning a code" />}
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.text }}>{perm && !perm.canAskAgain ? 'Camera access is off for CLAN.' : 'CLAN needs the camera to scan a code.'}</Text>
          {perm && !perm.canAskAgain ? <Btn small label="Open Settings" onPress={() => void Linking.openSettings()} /> : <Btn small label="Allow camera" onPress={() => void ask()} />}
        </View>
      )}
      {hint && <Muted small>{hint}</Muted>}
      <Row><Btn small label="Scan a picture instead" onPress={() => void fromPicture()} /><Btn small label="Close" onPress={onClose} /></Row>
      {err && <Text style={{ color: c.danger }}>{err}</Text>}
    </View>
  );
}
