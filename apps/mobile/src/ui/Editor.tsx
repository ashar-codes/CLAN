import {useState,type ReactNode} from 'react';
import {Alert,KeyboardAvoidingView,Modal,Platform,ScrollView,View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {act,Btn,Err,Field,H1,Row,useC} from './kit';

/** Native editing surface: actions stay reachable while only the fields scroll. Drafts survive validation errors. */
export function Editor({title,initial,labels,multiline=[],onSave,onClose,children,extraDirty=false,read}:{title:string;initial:Record<string,string>;labels:Record<string,string>;multiline?:string[];onSave(v:Record<string,string>):unknown;onClose():void;children?:ReactNode;extraDirty?:boolean;read?:()=>Record<string,string>}){
 const c=useC(),insets=useSafeAreaInsets(),[base]=useState(initial),[draft,setDraft]=useState(initial),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const dirty=extraDirty||JSON.stringify(draft)!==JSON.stringify(base);
 const close=()=>{if(busy)return;if(dirty)Alert.alert('Discard changes?',`Unsaved edits to “${title}” will be lost.`,[{text:'Keep editing',style:'cancel'},{text:'Discard',style:'destructive',onPress:onClose}]);else onClose();};
 const save=async()=>{if(busy)return;setBusy(true);try{const fresh=read?read():initial;if(Object.keys(base).some(k=>fresh[k]!==base[k]))throw new Error('This item changed or was deleted. Your draft is kept; review the latest item before saving.');await onSave(draft);setError(act(()=>{}));onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
  <KeyboardAvoidingView style={{flex:1,backgroundColor:c.bg,paddingTop:insets.top,paddingBottom:insets.bottom}} behavior={Platform.OS==='ios'?'padding':'height'}>
   <View style={{padding:16,gap:10}}><H1>{title}</H1><Row><Btn primary label={busy?'Saving…':'Save'} disabled={busy} onPress={()=>void save()}/><Btn label="Cancel" disabled={busy} onPress={close}/></Row><Err msg={error}/></View>
   <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:16,gap:12,paddingBottom:32}}>{Object.entries(labels).map(([key,label])=><Field key={key} label={label} value={draft[key]??''} onChange={v=>setDraft({...draft,[key]:v})} multiline={multiline.includes(key)}/>)}{children}</ScrollView>
  </KeyboardAvoidingView>
 </Modal>;
}
export function confirmRemove(name:string,consequences:string,action:()=>unknown,onError:(error:string|null)=>void){
 Alert.alert(`Delete “${name}”?`,consequences,[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>onError(act(action))}]);
}
