import XCTest
final class CLANQASmoke: XCTestCase {
  func testForegroundResume() throws {
    let app = XCUIApplication(bundleIdentifier: "app.classroomlan.student"); app.launch()
    XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout: 45))
    app.descendants(matching: .any).matching(identifier: "People").firstMatch.tap()
    XCTAssertTrue(app.buttons["Nearby"].waitForExistence(timeout: 15))
    XCUIDevice.shared.press(.home); app.activate()
    XCTAssertTrue(app.buttons["Nearby"].waitForExistence(timeout: 15))
    // Actual native resume/navigation; this does not claim a remote LAN peer or suspended listening.
    app.buttons["Nearby"].tap()
    let limitation = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Limited by iOS")).firstMatch
    for _ in 0..<12 { if limitation.isHittable { break }; app.swipeUp() }
    XCTAssertTrue(limitation.exists)
  }

  func testProfileNoteAndRestart() throws {
    let app = XCUIApplication(bundleIdentifier: "app.classroomlan.student")
    app.launch()
    let name = app.textFields["Full name"]
    if name.waitForExistence(timeout: 30) {
      name.tap(); name.typeText("Local QA")
      let roll = app.textFields["Student / roll number"]; roll.tap(); roll.typeText("QA-143")
      let device = app.textFields["Device name"]; device.tap(); device.typeText("QA-Simulator")
      app.buttons["Save"].tap()
    }
    XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout: 45))
    app.descendants(matching: .any).matching(identifier: "Study").firstMatch.tap()
    app.descendants(matching: .any).matching(identifier: "Notes").firstMatch.tap()
    let title = "iOS QA persistence"
    if !app.buttons["Open note " + title].exists {
      app.buttons["New note"].tap()
      let field = app.textFields["Title"]; XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap(); for character in title { field.typeText(String(character)) }; XCTAssertEqual(field.value as? String, title)
      let body = app.textViews["Note"]; body.tap(); for character in "Disposable native simulator evidence" { body.typeText(String(character)) }; XCTAssertEqual(body.value as? String, "Disposable native simulator evidence")
      app.staticTexts["New note"].firstMatch.tap() // dismiss the software keyboard before tapping a scrolled button
      app.buttons["Save"].tap()
    }
    XCTAssertTrue(app.buttons["Open note " + title].waitForExistence(timeout: 15))
    app.terminate(); app.launch()
    XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout: 30))
    app.descendants(matching: .any).matching(identifier: "Study").firstMatch.tap(); app.descendants(matching: .any).matching(identifier: "Notes").firstMatch.tap()
    XCTAssertTrue(app.buttons["Open note " + title].waitForExistence(timeout: 15))
    app.buttons["Open note " + title].tap()
    XCTAssertEqual(app.textViews["Note"].value as? String, "Disposable native simulator evidence")
  }

  func testTimetablePersistence() throws {
    let app=XCUIApplication(bundleIdentifier:"app.classroomlan.student");app.launch()
    XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout:45))
    app.descendants(matching:.any).matching(identifier:"Study").firstMatch.tap()
    app.descendants(matching:.any).matching(identifier:"Timetable").firstMatch.tap()
    func reveal(_ element:XCUIElement){for _ in 0..<10 {if element.isHittable{return};app.swipeUp()};XCTAssertTrue(element.isHittable)}
    if !app.buttons["Edit timetable"].exists {
      app.buttons["Create timetable"].tap()
      let subject=app.textFields["Period subject"];reveal(subject);subject.tap();subject.typeText("Native iOS Mathematics")
      app.staticTexts["Add / edit period"].firstMatch.tap()
      let savePeriod=app.buttons["Save period"];reveal(savePeriod);savePeriod.tap()
      let save=app.buttons["Save timetable"];reveal(save);save.tap()
    }
    let select=app.buttons["Select active"];for _ in 0..<8 {if select.isHittable{break};app.swipeDown()};if select.isEnabled{select.tap()}
    app.terminate();app.launch();XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout:30))
    app.descendants(matching:.any).matching(identifier:"Study").firstMatch.tap();app.descendants(matching:.any).matching(identifier:"Timetable").firstMatch.tap()
    XCTAssertTrue(app.buttons["Edit timetable"].waitForExistence(timeout:15));app.buttons["Edit timetable"].tap()
    let text=app.staticTexts.containing(NSPredicate(format:"label CONTAINS %@","Native iOS Mathematics")).firstMatch;reveal(text);XCTAssertTrue(text.exists)
  }

  func testContentManagement() throws {
    let app=XCUIApplication(bundleIdentifier:"app.classroomlan.student");app.launch()
    XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout:45))
    app.descendants(matching:.any).matching(identifier:"Study").firstMatch.tap()
    app.descendants(matching:.any).matching(identifier:"Courses").firstMatch.tap()
    func reveal(_ element:XCUIElement){for _ in 0..<12{if element.isHittable{return};app.swipeUp()};XCTAssertTrue(element.isHittable)}
    func enter(_ label:String,_ text:String){let f=app.textFields[label];reveal(f);f.tap();for ch in text{f.typeText(String(ch))};XCTAssertEqual(f.value as? String,text)}
    let name="iOS lifecycle "+String(Int(Date().timeIntervalSince1970))
    enter("Course name",name);let add=app.buttons["Add course"];reveal(add);add.tap()
    let edit=app.buttons["Edit "+name];for _ in 0..<8{if edit.isHittable{break};app.swipeDown()};XCTAssertTrue(edit.waitForExistence(timeout:10));edit.tap()
    let instructor=app.textFields["Instructor"];XCTAssertTrue(instructor.waitForExistence(timeout:10));instructor.tap();instructor.typeText("QA teacher");app.buttons["Save"].tap()
    let archive=app.buttons["Archive "+name];XCTAssertTrue(archive.waitForExistence(timeout:10));archive.tap();app.buttons["Archived courses"].tap()
    let restore=app.buttons["Restore "+name];XCTAssertTrue(restore.waitForExistence(timeout:10));reveal(restore);restore.tap();app.buttons["Show active courses"].tap()
    let deletion=app.buttons["Delete course "+name];XCTAssertTrue(deletion.waitForExistence(timeout:10));reveal(deletion);deletion.tap();XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout:5));app.alerts.buttons["Cancel"].tap();XCTAssertTrue(app.buttons["Edit "+name].exists)
    deletion.tap();app.alerts.buttons["Delete"].tap();app.terminate();app.launch();XCTAssertTrue(app.buttons["Join a CLAN"].waitForExistence(timeout:30));app.descendants(matching:.any).matching(identifier:"Study").firstMatch.tap();app.descendants(matching:.any).matching(identifier:"Courses").firstMatch.tap();XCTAssertFalse(app.buttons["Edit "+name].exists)
  }
}
