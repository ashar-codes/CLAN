// Fatal startup errors remain test failures, not an unanswerable CI-native modal.
// Only disposable development profiles load this; redact key/token-like strings.
const safe = text => String(text).replaceAll(process.env.CLASSROOM_USER_DATA || '<unset>', '<QA profile>').replace(/[A-Za-z0-9+/_=-]{40,}/g, '[redacted]').slice(0, 500);
process.on('uncaughtExceptionMonitor', error => console.error('QA bootstrap failure ' + JSON.stringify({ name: error.name, code: error.code, message: safe(error.message) })));
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

const originalError = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  if (title !== 'CLAN could not start') return originalError(title, content);
  console.error('QA recovery startup failure ' + JSON.stringify({ message: safe(content) }));
  // Production's catch still quits. No recovery/data assertion is bypassed.
};
