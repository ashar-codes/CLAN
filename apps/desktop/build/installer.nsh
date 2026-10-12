; CLAN installer firewall rules (the installer is per-machine, so this runs elevated). Program-scoped, inbound, local
; subnet only. Never allow-all. Per-session "CLAN Direct <session>" rules are removed by CLAN at session end and on next launch.
;   ${APP_EXECUTABLE_FILENAME} TCP: HTTPS/WSS classroom + pairing + sync.   ${APP_EXECUTABLE_FILENAME} UDP: mDNS discovery answers.
;   livekit-server.exe UDP: screen-sharing media (one UDP port; signalling goes through ${APP_EXECUTABLE_FILENAME}).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} discovery (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} screen sharing (local network)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${PRODUCT_NAME} (local network)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP remoteip=localsubnet enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${PRODUCT_NAME} discovery (local network)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP remoteip=localsubnet enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${PRODUCT_NAME} screen sharing (local network)" dir=in action=allow program="$INSTDIR\resources\livekit-server.exe" protocol=UDP remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} discovery (local network)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} screen sharing (local network)"'
!macroend
