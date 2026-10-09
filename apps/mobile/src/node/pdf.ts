// PDF.js is not bundled on the phone (size, and it parses untrusted PDFs): core's AI extraction reports PDFs as
// unsupported here instead of failing. Notes, text and Markdown sources still work.
const unsupported = () => Object.assign(new Error('Reading PDFs isn’t available on this phone yet.'), { code: 'unsupported' });
type Doc = { numPages: number; getPage(i: number): Promise<{ getTextContent(): Promise<{ items: { str: string; hasEOL: boolean }[] }> }> };
export function getDocument(_o: unknown): { promise: Promise<Doc>; destroy(): Promise<void> } { return { promise: Promise.reject(unsupported()), destroy: async () => {} }; }
export const GlobalWorkerOptions = {};
