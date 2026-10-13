import { z } from 'zod';
/** No commands, clipboard, paths, modifiers or arbitrary key codes cross this boundary. */
export const ControlInput = z.discriminatedUnion('type', [
 z.object({type:z.literal('pointer'),x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),action:z.enum(['move','click','down','up'])}).strict(),
 z.object({type:z.literal('scroll'),delta:z.number().int().min(-10).max(10)}).strict(),
 z.object({type:z.literal('text'),text:z.string().min(1).max(32).refine(t=>!/[\u0000-\u001f\u007f]/.test(t))}).strict(),
 z.object({type:z.literal('key'),key:z.enum(['Enter','Backspace','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])}).strict(),
]);
export type ControlInput = z.infer<typeof ControlInput>;
export const ControlAction = z.discriminatedUnion('action',[
 z.object({action:z.literal('request'),target:z.string().min(1).max(64),screen:z.string().min(1).max(128)}).strict(),
 z.object({action:z.literal('approve'),request:z.uuid()}).strict(),z.object({action:z.literal('reject'),request:z.uuid()}).strict(),
 z.object({action:z.literal('revoke'),grant:z.uuid().optional()}).strict(),z.object({action:z.literal('pull')}).strict(),
 z.object({action:z.literal('input'),grant:z.uuid(),seq:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),input:ControlInput}).strict(),
]);
export type ControlAction=z.infer<typeof ControlAction>;
export type ControlPerson={identity:string;name:string;fingerprint?:string};
export type ControlView={me:string;screens:{identity:string;screen:string;name:string}[];requests:{id:string;controller:ControlPerson;target:string;screen:string;expiresAt:number}[];grant:null|{id:string;controller:ControlPerson;target:string;screen:string;expiresAt:number};inputs:{seq:number;input:ControlInput}[]};
