import {requireOptionalNativeModule} from 'expo-modules-core';
export const TimetableOCR=requireOptionalNativeModule<{recognize(uri:string):Promise<{text:string;uncertain:boolean}>}>('TimetableOCR');
