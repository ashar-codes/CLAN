Pod::Spec.new do |s|
 s.name='TimetableOCR'; s.version='1.0.0'; s.summary='Private on-device timetable recognition'; s.description=s.summary; s.license={:type=>'MIT'}; s.author='CLAN'; s.homepage='https://github.com/ashar-codes/CLAN'; s.platform=:ios,'15.1'; s.source={:git=>'https://github.com/ashar-codes/CLAN'}; s.static_framework=true; s.dependency 'ExpoModulesCore'; s.source_files='*.swift'; s.swift_version='5.9'; s.frameworks='Vision','ImageIO'
end
