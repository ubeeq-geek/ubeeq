import {marshall} from '@aws-sdk/util-dynamodb';
import type {AttributeValue} from '@aws-sdk/client-dynamodb';
export const DYNAMO_MAX_ITEM_BYTES=400*1024;
export const DYNAMO_MAX_TRANSACTION_BYTES=4*1024*1024;
export class DynamoCapacityError extends Error {readonly code='physical_transaction_capacity';constructor(message:string){super(message);this.name='DynamoCapacityError';}}
const utf8=(value:string)=>Buffer.byteLength(value,'utf8');
function numberBytes(value:string):number {
 // Dynamo numbers use significant decimal digits, not the escaped JSON wire
 // spelling. Leading/trailing zeroes and exponent spelling are not digits of
 // the stored significand. Negative values retain their sign overhead.
 const coefficient=value.toLowerCase().split('e')[0],digits=coefficient.replace(/^[+-]/,'').replace('.','').replace(/^0+/,'').replace(/0+$/,'');
 return Math.ceil(Math.max(1,digits.length)/2)+1+(value.startsWith('-')?1:0);
}
function valueBytes(value:AttributeValue):number {
 if(value.S!==undefined)return utf8(value.S);if(value.N!==undefined)return numberBytes(value.N);if(value.B!==undefined)return value.B.byteLength;
 if(value.BOOL!==undefined||value.NULL!==undefined)return 1;
 if(value.L!==undefined)return 3+value.L.reduce((sum,item)=>sum+1+valueBytes(item),0);
 if(value.M!==undefined)return 3+Object.entries(value.M).reduce((sum,[key,item])=>sum+utf8(key)+1+valueBytes(item),0);
 if(value.SS!==undefined)return value.SS.reduce((sum,item)=>sum+utf8(item),0);
 if(value.NS!==undefined)return value.NS.reduce((sum,item)=>sum+numberBytes(item),0);
 if(value.BS!==undefined)return value.BS.reduce((sum,item)=>sum+item.byteLength,0);
 throw new DynamoCapacityError('An unsupported physical AttributeValue cannot be budgeted.');
}
/** Measures the actual marshalled item attributes. SDK protocol labels/base64
 * and JSON wire escaping are not part of Dynamo's stored item size. */
export function dynamoItemBytes(value:Record<string,unknown>):number {
 const attributes=marshall(value,{removeUndefinedValues:true});return Object.entries(attributes).reduce((sum,[key,item])=>sum+utf8(key)+valueBytes(item),0);
}
export function dynamoItemFits(value:Record<string,unknown>):boolean{return dynamoItemBytes(value)<=DYNAMO_MAX_ITEM_BYTES;}
export function assertDynamoItemFits(value:Record<string,unknown>):void {if(!dynamoItemFits(value))throw new DynamoCapacityError('The full physical Dynamo item exceeds 400KiB.');}
