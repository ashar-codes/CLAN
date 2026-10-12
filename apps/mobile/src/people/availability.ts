// Keep mode is explicit Android consent. iOS suspension never implies continuous LAN availability.
export function retainPeople(platform: string, mode: string, connected: boolean): boolean {
  return platform === 'android' && (mode === 'keep' || mode === 'session' && connected);
}
