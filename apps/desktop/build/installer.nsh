; CLAN installer firewall rule (runs elevated during install). Program-scoped, inbound TCP, local subnet only.
; Never allow-all. Per-session "CLAN Direct <session>" rules are removed by CLAN at session end and on next launch.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN (local network)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="CLAN (local network)" dir=in action=allow program="$INSTDIR\CLAN.exe" protocol=TCP remoteip=localsubnet enable=yes'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="CLAN (local network)"'
!macroend
