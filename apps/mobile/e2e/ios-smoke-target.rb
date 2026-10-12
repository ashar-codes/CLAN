# Adds the native UI smoke scheme to a disposable Expo-generated Xcode project.
# Run with CocoaPods' Ruby environment; never point this at a user's original project.
require 'xcodeproj'
require 'fileutils'
root = File.expand_path(ARGV.fetch(0))
FileUtils.cp(File.join(__dir__, 'ios-smoke.swift'), File.join(root, 'CLANQASmoke.swift'))
p = Xcodeproj::Project.open(File.join(root, 'CLAN.xcodeproj'))
t = p.targets.find { |x| x.name == 'CLANQASmoke' } || p.new_target(:ui_test_bundle, 'CLANQASmoke', :ios, '18.0')
g = p.main_group.find_subpath('CLANQASmoke', true)
g.set_source_tree('SOURCE_ROOT')
r = g.files.find { |x| x.path == 'CLANQASmoke.swift' } || g.new_file('CLANQASmoke.swift')
t.add_file_references([r]) if t.source_build_phase.files.empty?
t.build_configurations.each do |c|
  c.build_settings.merge!('PRODUCT_NAME' => 'CLANQASmoke', 'PRODUCT_BUNDLE_IDENTIFIER' => 'app.classroomlan.qa.smoke',
    'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => 'CLAN', 'CODE_SIGN_STYLE' => 'Automatic')
end
a = p.targets.find { |x| x.name == 'CLAN' }
t.add_dependency(a) unless t.dependencies.any? { |d| d.target == a }
p.save
s = Xcodeproj::XCScheme.new
s.add_build_target(a); s.add_build_target(t); s.add_test_target(t)
s.save_as(File.join(root, 'CLAN.xcodeproj'), 'CLANQASmoke', true)
