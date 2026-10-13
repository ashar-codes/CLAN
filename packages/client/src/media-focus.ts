// One user-authorized capture session per app. Never publish a microphone into two calls accidentally.
let current:object|null=null;
export function mediaBusy(owner:object){return current!==null && current!==owner;}
export function acquireMedia(owner:object){if(mediaBusy(owner))throw Error('Another call or meeting is active. Leave it before joining.');current=owner;}
export function releaseMedia(owner:object){if(current===owner)current=null;}
