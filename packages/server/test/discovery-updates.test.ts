import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>void>(),expire:vi.fn(),update:vi.fn(),stop:vi.fn(),destroy:vi.fn()}));
vi.mock('bonjour-service',()=>({Bonjour:class{find(){return{services:[],on:(event:string,fn:(...args:any[])=>void)=>state.handlers.set(event,fn),expire:state.expire,update:state.update,stop:state.stop};}destroy=state.destroy;}}));
import {browse,type DiscoveredClassroom} from '../src/discovery.ts';
afterEach(()=>vi.useRealTimers());
it('endpoint/TXT changes reach subscribers, expired hints are checked, and shutdown stops requery',()=>{
 vi.useFakeTimers();let current:DiscoveredClassroom[]=[];const stop=browse(list=>current=list),base={port:12345,addresses:['192.168.4.22'],txt:{v:'1',sid:'qa-session',a:'192.168.4.22',title:'Original',type:'FRIENDS'}};
 state.handlers.get('up')!(base);expect(current[0]?.url).toBe('http://192.168.4.22:12345');
 state.handlers.get('srv-update')!({...base,port:23456},base);expect(current[0]?.url).toBe('http://192.168.4.22:23456');
 state.handlers.get('txt-update')!({...base,port:23456,txt:{...base.txt,title:'Changed'}},base);expect(current[0]?.title).toBe('Changed');
 vi.advanceTimersByTime(3000);expect(state.expire).toHaveBeenCalledTimes(1);expect(state.update).toHaveBeenCalledTimes(1);
 state.handlers.get('down')!(base);expect(current).toHaveLength(0);stop();vi.advanceTimersByTime(6000);expect(state.update).toHaveBeenCalledTimes(1);expect(state.destroy).toHaveBeenCalledTimes(1);
});
