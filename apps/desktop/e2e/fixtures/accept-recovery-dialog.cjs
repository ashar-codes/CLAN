// Only explicitly loaded by the disposable crash/recovery fixture. A native OS modal
// can block Playwright attaching the restored window on Windows; acknowledge its OK
// action and assert that the application presented the real recovery explanation.
const { app, dialog } = require('electron');
if (app.isPackaged || !process.env.CLASSROOM_USER_DATA) throw Error('Recovery fixture requires a disposable development profile');
const original = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = (...args) => {
  const options = args.at(-1);
  if (options?.title === 'CLAN restored your data') {
    globalThis.__qaRecoveryWarning = true;
    return Promise.resolve({ response: 0, checkboxChecked: false });
  }
  return original(...args);
};
