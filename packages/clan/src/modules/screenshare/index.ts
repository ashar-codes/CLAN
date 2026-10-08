// Screen sharing (control events only). Media lives in the host's SFU behind MediaTransport; this module never sees
// frames, window titles or media internals — only who presented what kind of source, when, and why it stopped.
import { z } from 'zod';
import { defineEvent } from '../../core/events.ts';

const Ids = { sessionId: z.string(), presentationId: z.string() };
export const PresentationRequested = defineEvent('PresentationRequested', 1, z.object({ sessionId: z.string(), memberId: z.string() }));
export const PresentationApproved = defineEvent('PresentationApproved', 1, z.object({ sessionId: z.string(), memberId: z.string() }));
export const PresentationDeclined = defineEvent('PresentationDeclined', 1, z.object({ sessionId: z.string(), memberId: z.string() }));
export const PresentationStarted = defineEvent('PresentationStarted', 1, z.object({ ...Ids, presenter: z.string(), source: z.enum(['screen', 'window']), audio: z.boolean() }));
export const PresentationSourceChanged = defineEvent('PresentationSourceChanged', 1, z.object({ ...Ids, source: z.enum(['screen', 'window']), audio: z.boolean() }));
export const PresentationStopped = defineEvent('PresentationStopped', 1, z.object({ ...Ids, reason: z.string().max(40) }));
