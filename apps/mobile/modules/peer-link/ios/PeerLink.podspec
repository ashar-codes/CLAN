Pod::Spec.new do |s|
  s.name           = 'PeerLink'
  s.version        = '0.1.0'
  s.summary        = 'CLAN peer transport: TCP + Bonjour with Apple peer-to-peer Wi-Fi for clan-link/1'
  s.author         = 'CLAN'
  s.homepage       = 'https://example.invalid/clan'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'NetworkExtension'
  s.source_files = '**/*.swift'
end
