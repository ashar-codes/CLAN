import XCTest
final class CLANQASmoke: XCTestCase {
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
}
