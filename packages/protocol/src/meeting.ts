import { z } from 'zod';
export const MeetingAction = z.discriminatedUnion('action', [
  z.object({action:z.literal('create'),mode:z.enum(['audio','video']),title:z.string().trim().min(1).max(80)}).strict(),
  z.object({action:z.literal('join')}).strict(), z.object({action:z.literal('leave')}).strict(), z.object({action:z.literal('decline')}).strict(), z.object({action:z.literal('end')}).strict(),
  z.object({action:z.literal('invite'),identity:z.string().max(64)}).strict(), z.object({action:z.literal('remove'),identity:z.string().max(64)}).strict(),
  z.object({action:z.literal('mute'),identity:z.string().max(64)}).strict(),
  z.object({action:z.literal('hand'),raised:z.boolean()}).strict(),
  z.object({action:z.literal('chat'),id:z.uuid(),text:z.string().trim().min(1).max(2000)}).strict(),
]);
export type MeetingAction = z.infer<typeof MeetingAction>;
export type MeetingView = {id:string;title:string;mode:'audio'|'video';owner:string;startedAt:number;invited:{identity:string;name:string;fingerprint?:string}[];joined:string[];hands:string[];chat:{id:string;identity:string;name:string;text:string;at:number}[]};
export type MeetingState = {me:string;canCreate:boolean;members:{identity:string;name:string;fingerprint?:string}[];meetings:MeetingView[]};
