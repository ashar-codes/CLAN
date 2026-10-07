Pod::Spec.new do |s|
  s.name           = 'PinnedTransport'
  s.version        = '0.1.0'
  s.summary        = 'CLAN: TLS pinned to the PAKE-authenticated per-class CA + leaf SPKI'
  s.author         = 'CLAN'
  s.homepage       = 'https://example.invalid/classroom-lan'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
