Pod::Spec.new do |s|
  s.name           = 'FileActions'
  s.version        = '0.1.0'
  s.summary        = 'CLAN verified Photos export and clipboard'
  s.author         = 'CLAN'
  s.homepage       = 'https://github.com/ashar-codes/CLAN'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Photos', 'CryptoKit'
  s.source_files = '**/*.swift'
end
