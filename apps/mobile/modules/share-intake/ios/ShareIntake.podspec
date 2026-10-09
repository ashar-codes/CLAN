Pod::Spec.new do |s|
  s.name           = 'ShareIntake'
  s.version        = '0.1.0'
  s.summary        = 'CLAN Share-to-CLAN: receives items handed over by the CLAN Share Extension'
  s.author         = 'CLAN'
  s.homepage       = 'https://example.invalid/clan'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
