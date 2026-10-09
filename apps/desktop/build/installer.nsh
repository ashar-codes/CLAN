; CLAN installer firewall rules (the installer is per-machine, so this runs elevated). Program-scoped, inbound, local
; subnet only. Never allow-all. Per-session "CLAN Direct <session>" rules are removed by CLAN at session end and on next launch.
;   CLAN.exe TCP: HTTPS/WSS classroom + pairing + sync.   CLAN.exe UDP: mDNS discovery answers.
;   livekit-server.exe UDP: screen-sharing media (one UDP port; signalling goes through CLAN.exe).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN discovery (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN screen sharing (local network)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="CLAN (local network)" dir=in action=allow program="$INSTDIR\CLAN.exe" protocol=TCP remoteip=localsubnet enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="CLAN discovery (local network)" dir=in action=allow program="$INSTDIR\CLAN.exe" protocol=UDP remoteip=localsubnet enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="CLAN screen sharing (local network)" dir=in action=allow program="$INSTDIR\resources\livekit-server.exe" protocol=UDP remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN discovery (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN screen sharing (local network)"'
!macroend
