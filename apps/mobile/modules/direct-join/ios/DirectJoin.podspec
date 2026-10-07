Pod::Spec.new do |s|
  s.name           = 'DirectJoin'
  s.version        = '0.1.0'
  s.summary        = 'CLAN Direct: BLE bootstrap central + joining the host Wi-Fi with an authenticated credential'
  s.author         = 'CLAN'
  s.homepage       = 'https://example.invalid/clan'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth', 'NetworkExtension'
  s.source_files = '**/*.swift'
end
