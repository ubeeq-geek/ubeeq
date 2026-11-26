import {GetCommand,DeleteCommand} from '@aws-sdk/lib-dynamodb';
const key=instanceId=>({pk:'instanceOperators#'+instanceId,sk:'record'});
export async function readReferenceOperator(client,tableName,instanceId){
 return(await client.send(new GetCommand({TableName:tableName,Key:key(instanceId),ConsistentRead:true}))).Item;
}
/** Test-fixture teardown only. Never reset an existing instance operator or a
 * changed/foreign claim. The caller must have observed absence before its own
 * successful Creator request and supply the actual authenticated actor. */
export async function releaseCreatedReferenceOperator(client,{tableName,instanceId,actorId,before,created}){
 if(before!==undefined||created===undefined)return false;
 const expected=key(instanceId);
 if(!actorId||created.pk!==expected.pk||created.sk!==expected.sk||created.repository!=='instanceOperators'||created.id!==instanceId||created.revision!==1||created.value?.id!==instanceId||created.value?.instanceId!==instanceId||created.value?.revision!==1||created.value?.actorId!==actorId)throw Error('Refusing to remove an unowned reference operator fixture.');
 try{
  await client.send(new DeleteCommand({TableName:tableName,Key:expected,ConditionExpression:'#value = :value AND #revision = :revision AND #repository = :repository AND #id = :id',ExpressionAttributeNames:{'#value':'value','#revision':'revision','#repository':'repository','#id':'id'},ExpressionAttributeValues:{':value':structuredClone(created.value),':revision':1,':repository':'instanceOperators',':id':instanceId}}));
  return true;
 }catch(error){if(error?.name==='ConditionalCheckFailedException')return false;throw error;}
}
